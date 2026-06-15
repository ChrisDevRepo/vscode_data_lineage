# UAT Readiness Report

**Branch:** `claude/code-review-cleanup-038ish` · **Date:** 2026-06-15

## Verdict: **GO for UAT**

The deterministic surface — extension load, dacpac→model pipeline, webview render (CSP), the host↔webview bridge, commands, config handling, diagnostics, and the graph engine — is **automated and green**. UAT can focus its effort on the lanes that are not automatable here: AI (`@lineage`) semantic quality, live-DB import, and visual/UX polish.

## Test surface (all automated, all green)

| Layer | Tool | Result |
|---|---|---|
| Static | `tsc --noEmit` (src) + `npm run build` (esbuild + vite) | clean |
| Unit | Vitest (7 projects) | **169 passing** |
| Integration | `@vscode/test-electron` (real EDH) | **15 passing** |

Run, fully unattended:
```
npm run typecheck      # tsc --noEmit
npm test               # unit (vitest) — 169
npm run test:integration   # EDH integration — 15 (downloads VS Code stable once)
```

### Integration tests (15) — verified via session state, logs, debug dump, CDP DOM/console (no screenshots)
- **Webview render smoke (CSP / blank-screen regression)** — real webview renders the demo graph, 0 console errors *(the bug this branch fixed, now guarded)*.
- **User behavior via bridge** — `filter-changed` round-trips into GUI STATE; `render-state` trace surfaces the origin in the dump.
- **Diagnostics & scaffolding** — `copyDebugInfo` dump sections + node-count match; `dumpSmState` no-throw + warning; `createParseRules`.
- **Dacpac → model pipeline** — `openDemo` loads the model; load recorded in the log trail.
- **Configuration handling** — DISPLAY key → rebuild-config; RELOAD key → notification; `refresh` no-panel guard.
- **Activation & registration** — API surface; all `dataLineageViz.*` commands registered; log capture live.

## Coverage map

| Subsystem | Unit | Integration | Status |
|---|---|---|---|
| Activation / command registration | — | ✔ | covered |
| Dacpac → model pipeline | ✔ (parser, graph) | ✔ | covered |
| Webview render / CSP (blank-screen) | — | ✔ (CDP) | covered |
| Host↔webview bridge (filter, render-state, show-detail) | ✔ (contract) | ✔ (CDP sim) | covered |
| Config reload (RELOAD vs DISPLAY) | — | ✔ | covered |
| Diagnostics (debug dump, dumpSmState) | ✔ | ✔ | covered |
| Graph engine (BFS, traceScope, schemaProjection, graphBuilder, display-mode) | ✔ (extensive) | (via pipeline) | covered |
| React components / hooks | ✔ (jsdom) | (render via CDP) | covered |
| drawioExporter, profilingEngine | ✔ (new) | — | covered |
| **AI `@lineage` participant** | partial (Zod/FSM units) | — | **UAT lane** |
| **Live SQL Server / DMV import** | mocked extraction | — | **UAT / manual** |

## Code review

LOW risk (full review in `docs/E2E_TESTING.md` history / plan). Review fixes applied and verified (`tsc` clean, unit green): `img-src` tightened, detail-panel `localResourceRoots`, `participantUtils` dead-import + stray-JSDoc cleanup, `getNonce` doc. No Critical/High findings.

## Residual risks → what UAT should focus on

1. **AI `@lineage` semantic quality** (discovery, SM hop-by-hop, gate, column-trace, synthesis). The deterministic pipeline (Zod boundaries, session FSM, tool dispatch) is unit-tested; *semantic correctness* is not automatable (needs Copilot in the EDH) and is the existing UAT lane — use the baseline captures + `uat-analyze` / `iteration-review` skills.
2. **Live-DB / DMV import** against a real SQL Server (per decision, e2e is dacpac-only). Validate connection, DMV extraction, and profiling manually with a real database.
3. **Visual / UX across themes** (Light / Dark / High-Contrast) and fine interaction polish — human spot-check; automation here asserts structure/state, not aesthetics.

## How verification works (for re-runs / CI)

Programmatic-first, state-driven (see `docs/E2E_TESTING.md`): drive via `executeCommand` and real bridge messages; assert from `testLogCapture`, `getSession()`, the `copyDebugInfo` dump, and CDP DOM/console. No screenshots in the assertion path. The integration run is CI-ready (headless EDH download + Mocha); only the AI and live-DB lanes remain manual.
