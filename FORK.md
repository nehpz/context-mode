# Fork Notes — context-mode (nehpz)

This is a personal fork of [context-mode](https://github.com/mksglu/context-mode). Its single purpose: **full-parity hook support for omp (Oh My Pi)**, which upstream integrates MCP-only. Nothing here is intended for upstream; the design optimizes for cheap syncs, not pattern conformance.

Plan of record: `docs/plans/2026-07-20-001-feat-omp-hook-parity-plan.md`.

## Seam inventory (the entire divergence)

| Surface | Change |
|---|---|
| `package.json` | One added line: second `omp.extensions` entry (`./build/adapters/omp/bridge.js`) |
| `src/adapters/omp/bridge.ts` | Fork-owned bridge module (all logic lives here) |
| `tests/adapters/omp-bridge.test.ts` | Fork-owned tests |
| `FORK.md`, `docs/plans/` | Fork-owned docs |

Everything else is pristine upstream. The bridge is a **gap-filler**: upstream's `src/adapters/omp/plugin.ts` owns session rows, `tool_result` capture, the bash HTTP block, pre-compact snapshots, and `turn_end` cost. The bridge owns context-chain injection, user-prompt capture, `routePreToolUse` routing, status display, and the `/ctx-stats` `/ctx-doctor` commands. One writer per data surface — the bridge's only DB writes are `UserPromptSubmit` rows and `markResumeConsumed`.

## One-time setup

```bash
git remote add upstream https://github.com/mksglu/context-mode.git
git config rerere.enabled true
```

## Sync ritual (merge-based; never rebase)

1. `git fetch upstream && git merge upstream/main`
2. `rerere` replays remembered conflict resolutions.
3. **Bundles are never hand-merged.** On any `*.bundle.mjs` conflict — including `hooks/session-attribution.bundle.mjs`, which the build does NOT regenerate — take theirs: `git checkout --theirs -- '*.bundle.mjs'`.
4. `npm run build` — regenerates the six built bundles AND type-checks the bridge against moved upstream internals. A compile error here is the drift detector working: fix it inside `src/adapters/omp/bridge.ts` only.
5. **Retirement review:** `git diff HEAD@{1} -- src/adapters/omp/plugin.ts`. If upstream's plugin absorbed a capability the bridge provides (they are actively converging on omp parity), delete the bridge's version — the fork should shrink over time. Also re-check the bridge's `deriveSessionId` copy still matches upstream's.
6. `npx vitest run tests/adapters/` — upstream plugin tests and bridge tests both green.
7. Smoke-test an omp session in this repo (routing guidance visible, blocked pattern blocks, `/ctx-stats` responds, `ctx_stats` shows the session once).
8. Commit the merge (regenerated bundles included).

## Accepted divergences

- `routePreToolUse` `modify`/`ask` decisions are allowed-and-logged (omp's `tool_call` API is `{block, reason}` only — no input mutation). Mooted in practice: omp subagent sessions load the same extensions and get their own injection.
- Upstream's blanket bash curl/wget block stays authoritative (fires first); the bridge does not relax it to pi's safe-curl allowance.
- Upstream README / `docs/platform-support.md` still call omp MCP-only — deliberately not edited (doc churn = merge pain). This file carries reality.
- Adapter metadata (`OMPAdapter.paradigm`, doctor output) still reports mcp-only. Cosmetic; untouched.

## Deferred ideas

See "Deferred to Follow-Up Work" in the plan — notably the `tool_result` content-override token saver (replace an already-produced large output with an indexed preview; feasible under omp's last-override-wins semantics, needs its own design pass).
