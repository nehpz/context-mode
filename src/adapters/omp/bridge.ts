/**
 * FORK-OWNED — Oh My Pi (OMP) hook-parity bridge for context-mode.
 *
 * Loads as a SECOND entry in package.json `omp.extensions`, after upstream's
 * plugin (src/adapters/omp/plugin.ts). It is a gap-filler, never a
 * reimplementation: upstream owns session rows, tool_result event capture,
 * the bash HTTP block, pre-compact snapshots, and turn_end cost capture.
 * This bridge adds only what upstream does not do (plan:
 * docs/plans/2026-07-20-001-feat-omp-hook-parity-plan.md):
 *
 *   - before_agent_start + context: routing anchor, active_memory
 *     (buildAutoInjection), security fail-open warning, resume-snapshot
 *     consumption — the pi extension pattern (issue #598: append a message
 *     via the `context` chain, never mutate systemPrompt).
 *   - user-prompt event capture (extractUserEvents) — upstream records no
 *     UserPromptSubmit rows; these are bridge-owned (one writer per surface).
 *   - tool_call routing beyond upstream's bash block: routePreToolUse from
 *     hooks/core/routing.mjs with a bridge-local decision mapper (KTD7).
 *     Accepted parity gap: `modify`/`ask` decisions cannot be expressed in
 *     OMP's `{block, reason}` API — allowed and logged once.
 *   - agent_end status (ctx.ui.setStatus) + session_shutdown cleanup of
 *     bridge-local state only.
 *   - /ctx-stats and /ctx-doctor commands (pi parity-plus).
 *
 * ONE-WRITER RULE (R5): the only SessionDB writes here are UserPromptSubmit
 * rows and markResumeConsumed (injection bookkeeping for a snapshot upstream
 * wrote but never consumes). Everything else is read-only.
 *
 * Sync note (R10): on each upstream merge, diff plugin.ts and retire any
 * capability upstream absorbed. See FORK.md.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveSessionDbPath, SessionDB } from "../../session/db.js";
import type { StoredEvent } from "../../session/db.js";
import { extractUserEvents } from "../../session/extract.js";
import type { SessionEvent } from "../../types.js";
import { OMPAdapter } from "./index.js";

// ── Package-root resolution (KTD5) ──────────────────────
// bridge.js ships at <pkg>/build/adapters/omp/bridge.js; the hooks runtime
// sits at <pkg>/hooks/ — three up from the build output.
function resolvePackageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..");
}

/**
 * Dynamic-import an .mjs runtime module from the package root.
 *
 * Static import is impossible here: hooks/*.mjs live at the package root,
 * outside tsconfig `rootDir: src` — tsc cannot compile a static specifier
 * that escapes the root, and the modules are untyped runtime assets shared
 * with the subprocess hook platforms. Same pattern as the pi extension's
 * auto-injection loader.
 */
async function importHooksModule(relPath: string): Promise<Record<string, unknown> | null> {
  try {
    const abs = resolve(resolvePackageRoot(), relPath);
    if (!existsSync(abs)) return null;
    return (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ── Module-level singletons (mirrors plugin.ts) ─────────
let _db: SessionDB | null = null;
let _dbPath = "";
let _sessionId = "";
let _pendingContext = "";
let _securityInitStarted = false;
let _modifyGapLogged = false;

const _ompAdapter = new OMPAdapter();

function getDBPath(projectDir: string): string {
  return resolveSessionDbPath({ projectDir, sessionsDir: _ompAdapter.getSessionDir() });
}

// Separate handle from upstream's — better-sqlite3 serializes writers on the
// same file safely (same coexistence as MCP server + plugin today).
function getOrCreateDB(projectDir: string): SessionDB {
  const dbPath = getDBPath(projectDir);
  if (!_db || _dbPath !== dbPath) {
    if (_db) {
      try { _db.close(); } catch { /* best effort */ }
    }
    _db = new SessionDB({ dbPath });
    _dbPath = dbPath;
  }
  return _db;
}

// ── Session identity (KTD2) ──────────────────────────────
// Duplicate of plugin.ts deriveSessionId (unexported there). KEEP IN SYNC:
// src/adapters/omp/plugin.ts `deriveSessionId` — check on every upstream merge.
interface SessionManagerCtx {
  sessionManager?: { getSessionFile?: () => string };
}

function deriveSessionId(ctx: SessionManagerCtx | undefined): string {
  try {
    const sessionFile = ctx?.sessionManager?.getSessionFile?.();
    if (sessionFile && typeof sessionFile === "string") {
      return createHash("sha256").update(sessionFile).digest("hex").slice(0, 16);
    }
  } catch {
    // best effort
  }
  return `omp-${Date.now()}`;
}

// ── Routing runtime (lazy, KTD5) ─────────────────────────
interface RoutingDecision {
  action?: string;
  reason?: string;
  additionalContext?: string;
  updatedInput?: Record<string, unknown>;
  redirectMeta?: Record<string, unknown>;
}

interface RoutingModule {
  initSecurity: (buildDir: string) => Promise<void>;
  isSecurityInitFailed: () => boolean;
  buildSecurityWarningContext: () => string | null;
  routePreToolUse: (
    toolName: string,
    toolInput: Record<string, unknown>,
    projectDir: string,
    platform: string,
    sessionId: string,
    options?: { mcpToolsAvailable?: boolean },
  ) => RoutingDecision | null | undefined;
}

let _routing: RoutingModule | null | undefined = undefined;

async function getRouting(): Promise<RoutingModule | null> {
  if (_routing !== undefined) return _routing;
  const mod = await importHooksModule("hooks/core/routing.mjs");
  // Untyped .mjs runtime module — the shape assertion is checked by the
  // routePreToolUse presence probe and exercised by the import smoke test.
  _routing = mod && typeof mod.routePreToolUse === "function" ? (mod as unknown as RoutingModule) : null;
  return _routing;
}

async function ensureSecurityInit(routing: RoutingModule): Promise<void> {
  if (_securityInitStarted) return;
  _securityInitStarted = true;
  try {
    await routing.initSecurity(resolve(resolvePackageRoot(), "build"));
  } catch {
    // fail open — isSecurityInitFailed() surfaces the warning on the next turn
  }
}

// ── mapDecision (KTD7) ───────────────────────────────────
// deny → {block, reason}; context/redirect guidance → pending-context queue;
// modify carrying redirect guidance → block with the guidance as the reason
// (OMP cannot mutate tool input, so blocking-with-guidance is the closest
// fidelity to Claude's command rewrite); bare modify/ask → accepted parity
// gap — allow and log once.
function mapDecision(decision: RoutingDecision | null | undefined): { block: boolean; reason?: string } | undefined {
  if (decision?.additionalContext) queueContext(decision.additionalContext);
  if (!decision?.action) return undefined;
  switch (decision.action) {
    case "deny":
      return { block: true, reason: decision.reason ?? "Blocked by context-mode routing policy." };
    case "modify": {
      // routing.mjs redirects rewrite the command to `echo "<guidance>"` so
      // the model sees steering instead of the raw output. Extract that
      // guidance and deliver it as the block reason.
      const command = typeof decision.updatedInput?.command === "string" ? decision.updatedInput.command : "";
      const echoMatch = command.match(/^echo\s+"([\s\S]+)"\s*$/);
      if (echoMatch) {
        return { block: true, reason: echoMatch[1] };
      }
      if (decision.redirectMeta) {
        return {
          block: true,
          reason:
            "context-mode: this call was redirected. Use ctx_execute / ctx_fetch_and_index so the raw output stays out of the context window.",
        };
      }
      return logDecisionGap("modify");
    }
    case "ask":
      return logDecisionGap("ask");
    default:
      return undefined;
  }
}

function logDecisionGap(action: string): undefined {
  if (!_modifyGapLogged) {
    _modifyGapLogged = true;
    try {
      process.stderr.write(
        `context-mode omp bridge: '${action}' routing decisions without redirect guidance are an accepted parity gap on OMP (no tool-input mutation API); allowing tool call.\n`,
      );
    } catch { /* best effort */ }
  }
  return undefined;
}

function queueContext(text: string): void {
  if (!text) return;
  _pendingContext = _pendingContext ? `${_pendingContext}\n\n${text}` : text;
}

// ── Auto-injection (cached; runtime .mjs asset, see importHooksModule) ──
type AutoInjectionBuilder = (events: Array<{ category: string; data: string }>) => string;

let _buildAutoInjection: AutoInjectionBuilder | null | undefined = undefined;

async function getAutoInjection(): Promise<AutoInjectionBuilder | null> {
  if (_buildAutoInjection !== undefined) return _buildAutoInjection;
  const mod = await importHooksModule("hooks/auto-injection.mjs");
  _buildAutoInjection =
    mod && typeof mod.buildAutoInjection === "function" ? (mod.buildAutoInjection as AutoInjectionBuilder) : null;
  return _buildAutoInjection;
}

// ── Stats helpers (U6) ───────────────────────────────────
const TOKENS_PER_EVENT = 256; // lockstep with bin/statusline.mjs

function buildStatusText(db: SessionDB, sessionId: string): string {
  const eventCount = db.getEventCount(sessionId);
  const stats = db.getSessionStats(sessionId);
  const tokensSaved = eventCount * TOKENS_PER_EVENT;
  const tok = tokensSaved >= 1000 ? `${(tokensSaved / 1000).toFixed(1)}K` : String(tokensSaved);
  const compacts = stats?.compact_count ?? 0;
  return `ctx ${eventCount} ev ~${tok} tok${compacts ? ` ${compacts} compact` : ""}`;
}

function buildStatsText(db: SessionDB, sessionId: string): string {
  const stats = db.getSessionStats(sessionId);
  const eventCount = db.getEventCount(sessionId);
  const resume = db.getResume(sessionId);
  const tokensSaved = eventCount * TOKENS_PER_EVENT;
  return [
    "## context-mode stats (OMP)",
    "",
    `- Session: \`${sessionId.slice(0, 8)}...\``,
    `- Events captured: ${eventCount}`,
    `- Est. tokens kept out of context: ~${tokensSaved.toLocaleString()}`,
    `- Compactions: ${stats?.compact_count ?? 0}`,
    `- Resume snapshot: ${resume ? (resume.consumed ? "consumed" : "available") : "none"}`,
    `- Started: ${stats?.started_at ?? "unknown"}`,
  ].join("\n");
}

// ── Test-only state reset ────────────────────────────────
export function _resetOmpBridgeStateForTests(): void {
  if (_db) {
    try { _db.close(); } catch { /* best effort */ }
  }
  _db = null;
  _dbPath = "";
  _sessionId = "";
  _pendingContext = "";
  _securityInitStarted = false;
  _modifyGapLogged = false;
  _routing = undefined;
  _buildAutoInjection = undefined;
}

export function _getOmpBridgeSessionIdForTests(): string {
  return _sessionId;
}

export function _getPendingContextForTests(): string {
  return _pendingContext;
}

// ── HookAPI shape (local; superset of plugin.ts MinimalHookAPI) ──
type HookEventCtx = Record<string, unknown> | undefined;

interface ToolCallEvent {
  toolName?: string;
  toolCallId?: string;
  input?: Record<string, unknown>;
}

interface ToolCallEventResult {
  block?: boolean;
  reason?: string;
}

interface ContextEvent {
  messages: Array<{ role: string; content: unknown }>;
}

interface BeforeAgentStartEvent {
  prompt?: unknown;
}

interface StatusUiCtx {
  ui?: { setStatus?: (key: string, text: string) => void };
}

export interface OmpBridgeHookAPI {
  on(event: string, handler: (...args: never[]) => unknown): void;
  registerCommand?(
    name: string,
    command: { description: string; handler: (...args: unknown[]) => unknown },
  ): void;
}

// ── Bridge entry point ───────────────────────────────────
export default function ompBridge(pi: OmpBridgeHookAPI): void {
  const projectDir = process.env.PI_PROJECT_DIR || process.cwd();
  // No captured DB handle: session_shutdown closes the singleton, so every
  // DB-using handler reacquires via getOrCreateDB (cheap path-compare reopen).
  getOrCreateDB(projectDir);

  // ── session_start — rebind bridge session ID (never ensureSession: R5) ──
  pi.on("session_start", (_event: unknown, ctx: HookEventCtx) => {
    try {
      _sessionId = deriveSessionId(ctx as SessionManagerCtx | undefined);
    } catch {
      if (!_sessionId) _sessionId = `omp-${Date.now()}`;
    }
    return undefined;
  });

  // ── before_agent_start — build pending context + capture user prompt ──
  pi.on("before_agent_start", async (event: unknown) => {
    try {
      _pendingContext = "";
      if (!_sessionId) return undefined;
      const db = getOrCreateDB(projectDir);

      // U3 — user-prompt capture. Upstream records no UserPromptSubmit rows;
      // these are bridge-owned (verified against plugin.ts before adding).
      const startEvent = event as BeforeAgentStartEvent | undefined;
      const prompt = typeof startEvent?.prompt === "string" ? startEvent.prompt : "";
      if (prompt) {
        try {
          for (const ev of extractUserEvents(prompt)) {
            db.insertEvent(_sessionId, ev as SessionEvent, "UserPromptSubmit");
          }
        } catch { /* capture is best effort */ }
      }

      const parts: string[] = [];

      // U2 — lightweight routing anchor (pi Pi-1 pattern: OMP registers the
      // ctx_* MCP tools natively with descriptions; a 500-token hierarchy
      // anchor steers without the 7KB routing block).
      parts.push(
        "context-mode active. Hierarchy: ctx_batch_execute > ctx_execute > ctx_execute_file > ctx_search. " +
        "Read/edit files → ctx_execute_file. Multi-command research → ctx_batch_execute. " +
        "Web pages → ctx_fetch_and_index then ctx_search. Index docs → ctx_index. " +
        "Stats → ctx_stats. Doctor → ctx_doctor.",
      );

      // U2 — security fail-open warning. Init here (not only on tool_call) so
      // a missing security module surfaces on the same turn, not one late.
      const routing = await getRouting();
      if (routing) {
        await ensureSecurityInit(routing);
        if (routing.isSecurityInitFailed()) {
          const warning = routing.buildSecurityWarningContext();
          if (warning) parts.push(warning);
        }
      }

      // U5 — active_memory steering from events upstream captured (read-only).
      try {
        const activeEvents: StoredEvent[] = db
          .getEvents(_sessionId, { minPriority: 3, limit: 50 })
          .filter((e) => String(e.category ?? "") !== "role");
        if (activeEvents.length > 0) {
          const buildAuto = await getAutoInjection();
          if (buildAuto) {
            const memory = buildAuto(
              activeEvents.map((e) => ({ category: String(e.category ?? ""), data: String(e.data ?? "") })),
            );
            if (memory) parts.push(memory);
          }
        }
      } catch { /* steering is best effort */ }

      // U2 — resume snapshot consumption (upstream writes it, never injects).
      try {
        const resume = db.getResume(_sessionId);
        if (resume && !resume.consumed && resume.snapshot) {
          parts.push(String(resume.snapshot));
          db.markResumeConsumed(_sessionId);
        }
      } catch { /* best effort */ }

      _pendingContext = parts.join("\n\n");
    } catch {
      _pendingContext = "";
    }
    return undefined;
  });

  // ── context — flush the pending queue as an appended message (KTD3) ──
  pi.on("context", (event: unknown) => {
    try {
      if (!_pendingContext) return undefined;
      const text = _pendingContext;
      _pendingContext = "";
      const ev = event as ContextEvent;
      ev.messages.push({ role: "user", content: text });
      return { messages: ev.messages };
    } catch {
      return undefined;
    }
  });

  // ── tool_call — full routePreToolUse beyond upstream's bash block (U4) ──
  // Upstream's handler registered first: its bash HTTP block short-circuits
  // before this runs (KTD6). This handler covers everything else.
  pi.on("tool_call", async (event: unknown): Promise<ToolCallEventResult | undefined> => {
    try {
      const ev = event as ToolCallEvent | undefined;
      const toolName = typeof ev?.toolName === "string" ? ev.toolName : "";
      if (!toolName) return undefined;

      const routing = await getRouting();
      if (!routing) return undefined;
      await ensureSecurityInit(routing);

      const decision = routing.routePreToolUse(
        toolName,
        ev?.input ?? {},
        projectDir,
        "pi", // OMP shares pi's lowercase tool vocabulary; namer keys off it
        _sessionId,
        { mcpToolsAvailable: true },
      );
      return mapDecision(decision);
    } catch {
      return undefined; // fail open — routing must never break a tool call
    }
  });

  // ── agent_end — status display (writes nothing; KTD4) ──
  pi.on("agent_end", (_event: unknown, ctx: HookEventCtx) => {
    try {
      if (!_sessionId) return undefined;
      const ui = (ctx as StatusUiCtx | undefined)?.ui;
      ui?.setStatus?.("context-mode", buildStatusText(getOrCreateDB(projectDir), _sessionId));
    } catch { /* best effort */ }
    return undefined;
  });

  // ── session_shutdown — bridge-local cleanup only (no DB writes) ──
  pi.on("session_shutdown", () => {
    try {
      if (_db) {
        try { _db.close(); } catch { /* best effort */ }
      }
    } finally {
      _db = null;
      _dbPath = "";
      _sessionId = "";
      _pendingContext = "";
    }
    return undefined;
  });

  // ── Slash commands (pi parity-plus) ──────────────────────
  pi.registerCommand?.("ctx-stats", {
    description: "Show context-mode session statistics",
    handler: async () => {
      const text = !_sessionId
        ? "context-mode: no active session"
        : buildStatsText(getOrCreateDB(projectDir), _sessionId);
      return { text };
    },
  });

  pi.registerCommand?.("ctx-doctor", {
    description: "Run context-mode diagnostics",
    handler: async () => {
      const dbPath = getDBPath(projectDir);
      const lines = [
        "## ctx-doctor (OMP bridge)",
        "",
        `- DB path: \`${dbPath}\``,
        `- DB exists: ${existsSync(dbPath)}`,
        `- Session ID: \`${_sessionId ? _sessionId.slice(0, 8) + "..." : "none"}\``,
        `- Package root: \`${resolvePackageRoot()}\``,
        `- Project dir: \`${projectDir}\``,
        `- Routing runtime: ${(await getRouting()) ? "loaded" : "unavailable"}`,
      ];
      return { text: lines.join("\n") };
    },
  });
}
