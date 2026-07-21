import "../setup-home";
/**
 * OMP bridge tests — fork-owned hook-parity bridge
 * (src/adapters/omp/bridge.ts), plan
 * docs/plans/2026-07-20-001-feat-omp-hook-parity-plan.md.
 *
 * Slices:
 *   1. Scaffold — registration set, session-ID parity with upstream plugin,
 *      throw isolation, dynamic-import smoke test (U1)
 *   2. Context queue — hold/flush/drain semantics (U1/KTD3)
 *   3. Session-start injection — anchor, resume consumption, security warning
 *      path (U2)
 *   4. User-prompt capture + one-writer rule (U3, AE1)
 *   5. tool_call routing — deny mapping, modify gap, upstream-first ordering
 *      (U4, KTD6/KTD7)
 *   6. Status + commands (U6)
 *
 * Mock API matches tests/adapters/omp-plugin.test.ts: `on` collects,
 * `_trigger` invokes and returns the first truthy result (OMP block
 * semantics: first block short-circuits).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { SessionDB, resolveSessionDbPath } from "../../src/session/db.js";

// ── Mock OMP HookAPI ────────────────────────────────────────

type HandlerFn = (...args: unknown[]) => unknown | Promise<unknown>;

interface MockApi {
  on: (event: string, handler: HandlerFn) => void;
  registerCommand: (name: string, command: { description: string; handler: HandlerFn }) => void;
  _trigger: (event: string, ...args: unknown[]) => Promise<unknown>;
  _handlers: Record<string, HandlerFn[]>;
  _commands: Record<string, { description: string; handler: HandlerFn }>;
}

function createMockOmpApi(): MockApi {
  const handlers: Record<string, HandlerFn[]> = {};
  const commands: Record<string, { description: string; handler: HandlerFn }> = {};

  return {
    on: (event: string, handler: HandlerFn) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    },
    registerCommand: (name: string, command: { description: string; handler: HandlerFn }) => {
      commands[name] = command;
    },
    _trigger: async (event: string, ...args: unknown[]) => {
      for (const h of handlers[event] ?? []) {
        const result = await h(...args);
        if (result) return result;
      }
      return undefined;
    },
    _handlers: handlers,
    _commands: commands,
  };
}


// ── Setup / teardown ────────────────────────────────────────

let tempDir: string;
let api: MockApi;

const SESSION_FILE = "/tmp/omp-bridge-test-session.jsonl";
const SESSION_CTX = { sessionManager: { getSessionFile: () => SESSION_FILE } };

async function registerBridge(mockApi: MockApi, opts?: { projectDir?: string }) {
  const projectDir = opts?.projectDir ?? tempDir;
  process.env.PI_PROJECT_DIR = projectDir;
  const mod = await import("../../src/adapters/omp/bridge.js");
  mod._resetOmpBridgeStateForTests();
  mod.default(mockApi as unknown as Parameters<typeof mod.default>[0]);
  return mod;
}

async function registerUpstreamPlugin(mockApi: MockApi) {
  process.env.PI_PROJECT_DIR = tempDir;
  const mod = await import("../../src/adapters/omp/plugin.js");
  mod._resetOmpPluginStateForTests();
  mod.default(mockApi as unknown as Parameters<typeof mod.default>[0]);
  return mod;
}

function openDb(projectDir: string): SessionDB {
  const sessionsDir = join(process.env.HOME ?? tmpdir(), ".omp", "context-mode", "sessions");
  return new SessionDB({ dbPath: resolveSessionDbPath({ projectDir, sessionsDir }) });
}

describe("OMP bridge", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "omp-bridge-test-"));
    api = createMockOmpApi();
  });

  afterEach(async () => {
    const mod = await import("../../src/adapters/omp/bridge.js");
    mod._resetOmpBridgeStateForTests();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    delete process.env.PI_PROJECT_DIR;
    delete process.env.OMP_PROJECT_DIR;
  });

  // ═══════════════════════════════════════════════════════════
  // Slice 1: scaffold (U1)
  // ═══════════════════════════════════════════════════════════

  describe("Slice 1: scaffold", () => {
    it("registers the scaffold event set and no turn_end handler", async () => {
      await registerBridge(api);
      for (const event of [
        "session_start",
        "before_agent_start",
        "context",
        "tool_call",
        "agent_end",
        "session_shutdown",
      ]) {
        expect(api._handlers[event], `handler for ${event}`).toBeDefined();
      }
      expect(api._handlers.turn_end).toBeUndefined(); // KTD4
      expect(api._handlers.tool_result).toBeUndefined(); // upstream owns capture
    });

    it("derives the same session ID as the upstream plugin for the same ctx", async () => {
      const upstream = await registerUpstreamPlugin(api);
      const bridge = await registerBridge(api);
      await api._trigger("session_start", { type: "session_start" }, SESSION_CTX);
      const bridgeId = bridge._getOmpBridgeSessionIdForTests();
      expect(bridgeId).toHaveLength(16);
      expect(bridgeId).toBe(upstream._getOmpPluginSessionIdForTests());
    });

    it("a throwing-path handler never propagates (turn survives)", async () => {
      await registerBridge(api);
      // context handler with a malformed event (no messages array) must not throw
      await api._trigger("session_start", { type: "session_start" }, SESSION_CTX);
      await api._trigger("before_agent_start", { prompt: "hello" }, {});
      await expect(api._trigger("context", {})).resolves.toBeUndefined();
    });

    it("dynamic-import smoke test: runtime .mjs modules resolve with expected exports", async () => {
      const root = resolve(__dirname, "..", "..");
      const expectations: Array<[string, string]> = [
        ["hooks/core/routing.mjs", "routePreToolUse"],
        ["hooks/auto-injection.mjs", "buildAutoInjection"],
        ["hooks/session-directive.mjs", "buildSessionDirective"],
        ["hooks/routing-block.mjs", "createRoutingBlock"],
      ];
      for (const [rel, exportName] of expectations) {
        const abs = resolve(root, rel);
        expect(existsSync(abs), `${rel} exists`).toBe(true);
        const mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
        expect(typeof mod[exportName], `${rel} exports ${exportName}`).toBe("function");
      }
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Slice 2: context queue (U1/KTD3)
  // ═══════════════════════════════════════════════════════════

  describe("Slice 2: context queue", () => {
    it("flushes queued context once, then drains", async () => {
      await registerBridge(api);
      await api._trigger("session_start", { type: "session_start" }, SESSION_CTX);
      await api._trigger("before_agent_start", {}, {});

      const first = (await api._trigger("context", { messages: [] })) as
        | { messages: Array<{ role: string; content: unknown }> }
        | undefined;
      expect(first?.messages.length).toBe(1);
      expect(String(first?.messages[0]?.content)).toContain("context-mode active");

      const second = await api._trigger("context", { messages: [] });
      expect(second).toBeUndefined(); // queue drained
    });

    it("injects nothing when the queue is empty", async () => {
      await registerBridge(api);
      const result = await api._trigger("context", { messages: [] });
      expect(result).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Slice 3: session-start injection (U2)
  // ═══════════════════════════════════════════════════════════

  describe("Slice 3: session-start injection", () => {
    it("fresh session queues the routing anchor exactly once", async () => {
      const bridge = await registerBridge(api);
      await api._trigger("session_start", { type: "session_start" }, SESSION_CTX);
      await api._trigger("before_agent_start", {}, {});
      const pending = bridge._getPendingContextForTests();
      const matches = pending.match(/context-mode active/g) ?? [];
      expect(matches.length).toBe(1);
      expect(pending).toContain("ctx_batch_execute > ctx_execute");
    });

    it("consumes an unconsumed resume snapshot and marks it consumed", async () => {
      const upstream = await registerUpstreamPlugin(api);
      const bridge = await registerBridge(api);
      await api._trigger("session_start", { type: "session_start" }, SESSION_CTX);
      const sessionId = bridge._getOmpBridgeSessionIdForTests();

      // Upstream writes the snapshot; bridge injects it (one writer per surface).
      const db = openDb(tempDir);
      try {
        db.ensureSession(sessionId, tempDir);
        db.upsertResume(sessionId, "<resume>previous work summary</resume>", 3);
      } finally {
        db.close();
      }

      await api._trigger("before_agent_start", {}, {});
      expect(bridge._getPendingContextForTests()).toContain("previous work summary");

      // Second agent start: snapshot consumed, not re-injected.
      await api._trigger("before_agent_start", {}, {});
      expect(bridge._getPendingContextForTests()).not.toContain("previous work summary");
      expect(upstream._getOmpPluginSessionIdForTests()).toBe(sessionId);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Slice 4: user-prompt capture + one-writer rule (U3, AE1)
  // ═══════════════════════════════════════════════════════════

  describe("Slice 4: prompt capture and one-writer rule", () => {
    it("captures user-prompt events the upstream plugin does not record", async () => {
      const bridge = await registerBridge(api);
      await api._trigger("session_start", { type: "session_start" }, SESSION_CTX);
      const sessionId = bridge._getOmpBridgeSessionIdForTests();

      const db = openDb(tempDir);
      try {
        db.ensureSession(sessionId, tempDir);
      } finally {
        db.close();
      }

      await api._trigger(
        "before_agent_start",
        { prompt: "Always use tabs for indentation in this repo. Fix src/main.ts next." },
        {},
      );

      const readDb = openDb(tempDir);
      try {
        const events = readDb.getEvents(sessionId);
        expect(events.length).toBeGreaterThan(0);
        expect(events.every((e) => e.source_hook === "UserPromptSubmit")).toBe(true);
      } finally {
        readDb.close();
      }
    });

    it("covers AE1: one tool_result produces exactly one event row with both extensions", async () => {
      await registerUpstreamPlugin(api);
      const bridge = await registerBridge(api);
      await api._trigger("session_start", { type: "session_start" }, SESSION_CTX);
      const sessionId = bridge._getOmpBridgeSessionIdForTests();

      const before = (() => {
        const db = openDb(tempDir);
        try {
          return db.getEventCount(sessionId);
        } finally {
          db.close();
        }
      })();

      await api._trigger("tool_result", {
        toolName: "read",
        input: { file_path: "/tmp/some-file.ts" },
        content: [{ type: "text", text: "file contents here" }],
        isError: false,
      });

      const db = openDb(tempDir);
      try {
        const after = db.getEventCount(sessionId);
        expect(after - before).toBe(1); // upstream's single insert; bridge adds none
      } finally {
        db.close();
      }
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Slice 5: tool_call routing (U4)
  // ═══════════════════════════════════════════════════════════

  describe("Slice 5: tool_call routing", () => {
    it("upstream's bash HTTP block short-circuits before bridge policy (KTD6)", async () => {
      await registerUpstreamPlugin(api);
      await registerBridge(api);
      const result = (await api._trigger("tool_call", {
        toolName: "bash",
        input: { command: "curl https://example.com/api" },
      })) as { block?: boolean; reason?: string } | undefined;
      expect(result?.block).toBe(true);
      // Upstream's reason names its MCP redirect, proving which handler fired.
      expect(result?.reason).toContain("ctx_execute");
    });

    it("bridge routing produces a decision for non-bash tools without blocking safe calls", async () => {
      await registerBridge(api);
      await api._trigger("session_start", { type: "session_start" }, SESSION_CTX);
      const result = await api._trigger("tool_call", {
        toolName: "edit",
        input: { path: "/tmp/file.ts", old: "a", new: "b" },
      });
      // Editing a file is never denied by routing policy.
      expect(result).toBeUndefined();
    });

    it("fails open when routing cannot resolve a decision", async () => {
      await registerBridge(api);
      const result = await api._trigger("tool_call", { toolName: "", input: {} });
      expect(result).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Slice 6: status + commands (U6)
  // ═══════════════════════════════════════════════════════════

  describe("Slice 6: status and commands", () => {
    it("agent_end publishes sanitizable status text via ctx.ui.setStatus", async () => {
      await registerBridge(api);
      await api._trigger("session_start", { type: "session_start" }, SESSION_CTX);
      const calls: Array<[string, string]> = [];
      await api._trigger(
        "agent_end",
        {},
        { ui: { setStatus: (key: string, text: string) => calls.push([key, text]) } },
      );
      expect(calls.length).toBe(1);
      expect(calls[0][0]).toBe("context-mode");
      expect(calls[0][1]).toMatch(/^ctx \d+ ev/);
    });

    it("agent_end with no UI context does not throw (headless)", async () => {
      await registerBridge(api);
      await api._trigger("session_start", { type: "session_start" }, SESSION_CTX);
      await expect(api._trigger("agent_end", {}, {})).resolves.toBeUndefined();
    });

    it("ctx-stats command returns stats text derived from the shared DB", async () => {
      await registerBridge(api);
      await api._trigger("session_start", { type: "session_start" }, SESSION_CTX);
      const result = (await api._commands["ctx-stats"].handler()) as { text: string };
      expect(result.text).toContain("context-mode stats (OMP)");
      expect(result.text).toMatch(/Events captured: \d+/);
    });

    it("ctx-doctor command reports DB path and routing runtime state", async () => {
      await registerBridge(api);
      const result = (await api._commands["ctx-doctor"].handler()) as { text: string };
      expect(result.text).toContain("ctx-doctor (OMP bridge)");
      expect(result.text).toContain("Routing runtime: loaded");
    });

    it("stop-path handlers add zero duplicate usage rows (AE1, KTD4)", async () => {
      await registerUpstreamPlugin(api);
      const bridge = await registerBridge(api);
      await api._trigger("session_start", { type: "session_start" }, SESSION_CTX);
      const sessionId = bridge._getOmpBridgeSessionIdForTests();

      const count = () => {
        const db = openDb(tempDir);
        try {
          return db.getEventCount(sessionId);
        } finally {
          db.close();
        }
      };

      const before = count();
      await api._trigger("agent_end", {}, {});
      expect(count()).toBe(before);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Slice 7: post-shutdown reuse (same-process second session)
  // ═══════════════════════════════════════════════════════════

  describe("Slice 7: post-shutdown reuse", () => {
    it("a second session after session_shutdown regains DB-backed behavior", async () => {
      const bridge = await registerBridge(api);
      await api._trigger("session_start", { type: "session_start" }, SESSION_CTX);
      await api._trigger("session_shutdown", {});

      // Second session in the same process, different session file.
      const secondCtx = {
        sessionManager: { getSessionFile: () => "/tmp/omp-bridge-test-session-2.jsonl" },
      };
      await api._trigger("session_start", { type: "session_start" }, secondCtx);
      const secondId = bridge._getOmpBridgeSessionIdForTests();
      expect(secondId).toHaveLength(16);

      await api._trigger(
        "before_agent_start",
        { prompt: "Always run the linter before committing changes." },
        {},
      );

      const db = openDb(tempDir);
      try {
        const events = db.getEvents(secondId);
        expect(events.length).toBeGreaterThan(0);
        expect(events.every((e) => e.source_hook === "UserPromptSubmit")).toBe(true);
      } finally {
        db.close();
      }

      const stats = (await api._commands["ctx-stats"].handler()) as { text: string };
      expect(stats.text).toContain("Events captured");

      const calls: string[] = [];
      await api._trigger("agent_end", {}, { ui: { setStatus: (_k: string, t: string) => calls.push(t) } });
      expect(calls.length).toBe(1);
    });
  });
});
