# UAT Readiness Report

**Branch:** `claude/code-review-cleanup-038ish` · **Date:** 2026-06-15

## Verdict: **GO for UAT** — prod GO is **conditional on UAT sign-off** of the GUI/visual + AI + live-DB lanes

The **backend behind the GUI** — the engine logic of every headline feature plus the host glue — is automated and green. What automation deliberately does **not** cover (GUI interaction, visuals, AI semantics, live DB) is the UAT scope. Prod GO follows once UAT signs those off.

## Test surface (all automated, all green, no clicks/snapshots)

| Layer | Tool | Result |
|---|---|---|
| Static | `tsc --noEmit` (src) + `npm run build` | clean |
| Unit | Vitest (7 projects) | **172 passing** |
| Integration | `@vscode/test-electron` (real EDH) | **20 passing** |
| Parity | unit↔electron golden baseline (`engine-parity-baseline.json`) | byte-match ✓ |
| CI | GitHub Actions (Ubuntu+Windows, xvfb) runs all of the above per PR | wired |

Run, fully unattended:
```
npm run typecheck
npm test                  # unit — 171
npm run test:integration  # EDH integration — 19 (downloads VS Code stable once)
```

## Feature backend coverage (the "behind the GUI" logic)

Each headline feature's **computation** is unit-tested; its **host glue** (where it routes through the extension) is integration-tested via bridge messages / commands. The on-screen **interaction + visuals** are UAT.

| Feature | Backend logic (unit) | Host glue (integration) | GUI interaction / visual |
|---|---|---|---|
| Analytics (cycles/islands/hubs/longest-path/reachability) | `graphAnalysis.test.ts` ✓ | render-state mirror ✓ | UAT |
| Trace view (up/down depth BFS) | `traceScope.test.ts` ✓ | render-state ✓ | UAT |
| Shortest path | `traceScope.test.ts` (findShortestPathOrdered) ✓ | render-state ✓ | UAT |
| Full-text search | `modelSearch.test.ts` ✓ | show-detail/navigate ✓ | UAT |
| Exclusion (node/type/schema) | `dacpacExtractor.test.ts` (applyExclusionPatterns) ✓ | filter-changed ✓ | UAT |
| Export (draw.io) | `drawioExporter.test.ts` ✓ | `export-file` (host save dialog → UAT) | UAT |
| Save bookmark / view | `projectStore.test.ts` ✓ | `bridge-store.test.ts` (save/load/delete) ✓ | UAT |

## Integration tests (20) — verified via session state, logs, debug dump (no screenshots)
- **Engine parity (electron)** — the engine battery computed inside the real bundled extension byte-matches the unit golden baseline (catches integration/bundling/extraction regressions).
- Webview load smoke (CSP / blank-screen regression) — bundle executes under the real CSP, 0 console errors.
- User behavior via bridge — `filter-changed` → GUI STATE; `render-state` trace → origin in dump.
- Bridge handlers — `show-detail` (host log), `save-project` (session state), `save-view`/`delete-view` (no error), `request-projects`.
- Diagnostics — `copyDebugInfo` dump sections + node-count match; `dumpSmState` no-throw + warning; `createParseRules`.
- Dacpac → model pipeline — `openDemo` loads model; load in log trail.
- Config — DISPLAY→rebuild-config; RELOAD→notification; `refresh` no-panel guard.
- Activation & registration — API surface; all commands; log capture live.

## What automation does NOT cover (UAT scope)

1. **GUI interaction + visuals** — clicking the toolbar/menus, typing in search, canvas node selection, layout/zoom, theming (Light/Dark/HC), and overall look-and-feel. By design, automation drives via commands + bridge and asserts on state/logs/dump; on-screen behavior and appearance are validated by a human in UAT.
2. **AI `@lineage` semantic quality** — discovery, SM hop-by-hop, gate, column-trace, synthesis. The deterministic pipeline (Zod boundaries, FSM, dispatch) is unit-tested; semantic correctness needs Copilot in the EDH and is the existing UAT lane (baseline captures + `uat-analyze` / `iteration-review`).
3. **Live SQL Server / DMV import** — connection, DMV extraction, profiling against a real database (e2e is dacpac-only by decision).
4. **`export-file`** end-to-end — generation is unit-tested (`drawioExporter`); the host save-dialog write is UAT (a modal dialog blocks automation).

## Code review

LOW risk; review fixes applied and verified. No Critical/High. Details in `docs/E2E_TESTING.md` + commit history.

## How verification works (CI-ready)

Programmatic-first, state-driven (see `docs/E2E_TESTING.md`): drive via `executeCommand` + real bridge messages; assert from `testLogCapture`, `getSession()`, and the `copyDebugInfo` dump. No clicks, no screenshots. The integration run is headless-automated; only the UAT lanes above remain manual.
