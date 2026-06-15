# End-to-End & Integration Testing

How this extension is verified end-to-end **before UAT**, with the goal of minimizing production risk. This complements the unit-test docs in [`tests/README.md`](../tests/README.md) (canonical for the Vitest suites).

## Three principles

1. **Backend-only, no GUI interaction.** Automation exercises everything **behind the GUI** — the engine logic and the host glue — and **never clicks the UI or takes snapshots**. GUI interaction and visual checks are **UAT**, not automation. Drive only via `vscode.commands.executeCommand(...)` (commands) and `window.vscode.postMessage(...)` (bridge-host messages). Ingesting a message into the bridge is the way to simulate a user action; clicking a button is not.
2. **State-driven verification, not pixels.** Assert on structured, machine-readable signals — the **debug dump**, the **log capture**, **session state**, **render-state**. Goal: catch backend issues or missing parts. Screenshots / visual diffs are UAT only; they are never an automated assertion.
3. **Out-of-the-box only.** The official Microsoft framework `@vscode/test-cli` + `@vscode/test-electron` (Mocha in a real Extension Development Host) is the backbone. The only addition is the standard Electron `--remote-debugging-port`, which lets the same test read the rendered webview over the Chrome DevTools Protocol — no third-party UI framework, no webview mock.

## Why this shape

The webview cannot be reached by the official tooling alone — Microsoft's docs state `@vscode/test-electron` has *"a total lack of support for testing webviews."* But the bridge between the extension host and the webview is a clean `postMessage` boundary, and the extension exposes rich, readable diagnostics. So we drive the **host** programmatically, let the **real webview** do its work, and read the **result as text** — never by looking at the screen.

The actual algorithms behind search, trace, and filtering are pure engine code already covered by Vitest (`graphBuilder`, `traceScope`, `schemaProjection`, `modelSearch`, `useInteractiveTrace`, …). The e2e layers verify the *integration* — that a user-level action flows through the bridge and produces the expected state — not the math, which the unit layer owns.

---

## What is automated vs what is UAT

The headline features (analytics, trace view, shortest path, full-text search, exclusion, export, save bookmark) split into two layers that **are** automated and one that is **not**:

| Layer | What | How (automation) |
|---|---|---|
| **Backend logic** (the computation behind each feature) | `graphAnalysis`, `traceScope` / `traceNodeWithLevels`, `computeShortestPath`, `modelSearch`, `applyExclusionPatterns`, `drawioExporter`, `projectStore`, `schemaProjection` | **Unit tests** (Vitest) — call the function, assert the result |
| **Host glue** (what the GUI sends to the host) | bridge handlers: `filter-changed`, `render-state`, `save-view`/`save-project`/`load-project`, `show-detail`, `export-file`, `load-demo`; commands | **Integration** — `executeCommand` + `window.vscode.postMessage`, assert via dump / session / logs. **No clicks.** |
| **GUI interaction + visual** (clicking the toolbar, typing in search, canvas selection, layout/looks) | the actual on-screen flow | **UAT** — not automated here |

So a feature like *full-text search* is verified by unit-testing `modelSearch` (does the query find the right objects?) and, where it routes through the host, by posting the bridge message — **not** by typing into the search box. Whether the search box *looks* and *feels* right is UAT.

## Readable diagnostic surfaces (what the agent/test reads)

| Surface | Where | How to read | Reveals | Layer |
|---|---|---|---|---|
| **`buildDebugDump`** | [messageHandlers.ts:950](../src/bridge/messageHandlers.ts#L950) via `dataLineageViz.copyDebugInfo` ([commands.ts:97](../src/commands.ts#L97)) → clipboard | In-process call (L2); over CDP read clipboard after the command (validated: 8407 chars) | ENVIRONMENT, DATA SOURCE, MODEL + connectivity, SCHEMA LEGEND, PARSE STATS, GUI STATE, **RENDER STATE**, RENDERED CONNECTIVITY, **SELECTION & AFFORDANCES / TRACE SCOPE / DETAIL PANEL / ANALYTICS / BOOKMARK**, **LAST ERRORS**, SM SUMMARY | L2, L3 |
| **`testLogCapture`** | [log.ts:43](../src/utils/log.ts#L43); returned from `activate()` ([extension.ts:156](../src/extension.ts#L156)); gated by `process.env.VSCODE_EX_TEST` | In-process array of all `[Bridge]`/`[Parse]`/`[Stats]`/… log lines | Per-action log trail; success/failure milestones | L2 |
| **`getRecentLogs()`** | [log.ts:75](../src/utils/log.ts#L75) — always-on 200-line ring | In-process; **not yet in the debug dump** (see Enrichments) | Recent log history without the env gate | L2 (L3 after enrichment) |
| **`dumpSmState`** | [commands.ts:127](../src/commands.ts#L127) → writes `test-results/sm-dumps/sm-<ts>.json` | Read the file from disk | Full SM/engine state (AI only — out of scope here) | — |
| **Webview console + exceptions** | CDP `Runtime.consoleAPICalled` / `Runtime.exceptionThrown` / `Log.entryAdded` on the `vscode-webview` session | Node CDP client | React errors, CSP violations, unhandled rejections (0 = healthy) | L3 |
| **Live DOM metrics** | CDP, via the same-origin `active-frame` (see technique) | `Runtime.evaluate` against `active-frame.contentDocument` | Rendered node/edge counts, labels, `#root` present, mode | L3 |
| **`getSession()` / `getActivePanel()`** | `activate()` return | In-process | `model`, `uiState`, `phase`, `columnStore`, panel presence | L2 |
| **VS Code log files** | `context.logPath`; `code --logsPath <dir>` / `--log <id>:<level>` | Read files from disk | Host/output-channel logs off-process | L2/L3 fallback |

The richest single surface is the **debug dump** — one call yields the whole user-visible state as scannable text. Most assertions should read it.

---

## The validated CDP technique (reading the real webview)

Proven on this machine (Windows 11, VS Code 1.124.2, Electron 42). Zero dependencies — Node 21+ has a built-in `WebSocket` and `fetch`.

1. **Launch the EDH with remote debugging** (the same host F5 starts, plus one flag):
   ```
   code --extensionDevelopmentPath=<repo> --remote-debugging-port=9222 \
        --user-data-dir=<temp> --disable-extensions <repo>
   ```
   In CI/automation this is `@vscode/test-electron` with `launchArgs: ['--remote-debugging-port=9222', ...]`.
2. **Attach a Node CDP client** to `http://127.0.0.1:9222/json/version` → `webSocketDebuggerUrl`.
3. **Open the panel programmatically** — `executeCommand('dataLineageViz.openDemo')` from the Mocha test (preferred). (For a pure-CDP run without a host test, command-palette keystrokes work but are the fallback.)
4. **Reach the React app.** The frame nesting is:
   ```
   workbench page (vscode-file://)
     └─ iframe  vscode-webview://<id>/index.html      ← OOPIF, its own CDP session (auto-attach, flatten)
          └─ iframe id="active-frame"  (same-origin)  ← the real app: #root, React Flow
   ```
   Attach to the `vscode-webview` session, then evaluate against `document.getElementById('active-frame').contentDocument` to read the live DOM. No deeper OOPIF handling is needed because `active-frame` is same-origin with its parent.
5. **Read results** — DOM metrics, console-error count, and the debug dump (trigger `copyDebugInfo`, read the clipboard with `Browser.grantPermissions(['clipboardReadWrite'])` + `navigator.clipboard.readText()`).

**Note:** the Claude Code session's own `chrome-devtools` MCP cannot be used — it is bound to its own Chrome profile and refuses to attach to the EDH endpoint. Use the Node CDP client (also the CI-friendly choice). Reference skeleton lives under `tmp/cdp-*.mjs` (gitignored) during bring-up; the maintained harness will live in `tests/e2e/harness/`.

---

## Simulate user behavior through the bridge (no clicks, no pixels)

A user action is, at the boundary, a bridge message. Simulate it by sending that message and then read the outcome from the dump/logs. `window.vscode` in the webview is the **real** bridge to the host — posting through it is end-to-end, not a mock.

| User behavior | Simulate (programmatic) | Verify (state-driven) |
|---|---|---|
| **Load demo** | `executeCommand('dataLineageViz.openDemo')` | dump `MODEL` nodes/edges/schemas == expected; `testLogCapture` has `[Parse]`/`[Bridge]` load lines; webview console 0 errors |
| **Filter definition** | over CDP in `active-frame`: `window.vscode.postMessage({type:'filter-changed', uiState:{…schemas/types…}})` (or invoke the filter handler) | dump `GUI STATE` + `RENDER STATE` reflect the new scope; `RENDERED CONNECTIVITY` node count matches the filter |
| **Trace view** | start a trace in the webview (drive the trace control or post the trace request); the webview computes scope and posts `render-state` | dump `TRACE SCOPE` (origin, `tracedNodeIds` count) + `SELECTION & AFFORDANCES` (add/prune + grayed-reason) match expectation |
| **Full search** | drive the search input handler in the webview over CDP (or post the resulting navigate/show-detail) | DOM `react-flow__node` count narrows; `show-detail`/navigate logged; (enrichment: surface last query/result-count in render-state) |
| **Open node detail** | `window.vscode.postMessage({type:'show-detail', node})` | host opens detail panel (`getActivePanel`/detail session present); dump `DETAIL PANEL` shows the node + neighbors in/off-trace; `detail-ready` round-trip logged |
| **Save / load project** | `postMessage({type:'save-project', project})` then `{type:'load-project', id}` | `getSession()` project restored; round-trip equality; `testLogCapture` save/restore lines |
| **Config reload** | update a `dataLineageViz.*` setting | RELOAD key → reload-notify path; DISPLAY key → `rebuild-config` posted to panel ([extension.ts:146](../src/extension.ts#L146)); assert via dump/log |

Pure computation correctness (BFS depth, prune-safety, filter math, search ranking) is asserted at the **unit** layer; these e2e checks confirm the action *flows through the bridge and the host reflects the right state*.

---

## Layered plan

| Layer | Tool | Drives | Verifies via | Scope |
|---|---|---|---|---|
| **L0** Static gates | `tsc --noEmit`, esbuild + `vite build`, security-check, version-sync | — | exit codes | type/build/secret/version |
| **L1** Unit | Vitest (7 projects) | function calls + fake `BridgeHost` | return values, `testLogCapture` | parser, engine, trace/filter/search algorithms, host message handlers, React hooks/components |
| **L2** Integration (**primary**) | `@vscode/test-electron` (+`--remote-debugging-port`) | `executeCommand`, host API | **debug dump, `testLogCapture`, `getSession()`** | activation, commands, dacpac→model, host bridge handlers, config reload, detail panel, project store |
| **L3** Webview confirmation (thin) | same EDH run + Node CDP | `window.vscode.postMessage`, minimal | **DOM metrics, console errors, debug dump over CDP** | real render non-blank (CSP/blank-screen regression), filter/trace/search reflected in render-state |

Out of scope (per project decisions): `@lineage` AI participant (UAT lane) and live-DB/DMV import (dacpac only).

---

## Proposed enrichments (make the surfaces more test-friendly)

Small, low-risk additions that materially improve programmatic verification. **Recommended, pending approval:**

1. **`RECENT LOGS` section in `buildDebugDump`** — surface `getRecentLogs()` (the always-on 200-line ring) in the dump. Today the dump omits it, so an L3 (out-of-process) agent cannot read the log trail; adding it makes the full log history readable over CDP. *Highest value, lowest risk.*
2. **File output for the debug dump** — a variant of `copyDebugInfo` that also writes `test-results/debug-dumps/dump-<ts>.txt` (mirroring `dumpSmState`). Reading a file is robust and CI-friendly; clipboard needs window focus + a permission grant.
3. **Machine-readable JSON dump** — `buildDebugDumpJson()` alongside the human text, so assertions parse fields instead of regex-ing prose (aligns with the project's "structural over content" rule).
4. **Render-state completeness** — ensure `render-state` carries `renderedNodeCount`, `renderedEdgeCount`, `displayMode`, and `renderLimitHit`, and a `lastSearch` {query, matchCount}, so filter/search results are assertable from the dump without DOM reads.
5. **Stable `data-testid` hooks** on key webview nodes/controls — only where a CDP DOM read is unavoidable, to keep selectors stable across UI refactors.

All five keep production behavior unchanged (test-only outputs / additive fields).

---

## Parity regression net (unit ↔ electron golden baseline)

The strongest regression guard: every backend computation we have a known output for is asserted to produce the **same** output in **both** layers, against one committed golden file.

- **Single input:** `assets/demo.dacpac` (the same dacpac the EDH `openDemo` loads).
- **Single battery:** `buildEngineParityReport(model)` ([src/engine/engineParityReport.ts](../src/engine/engineParityReport.ts)) — deterministic (sets sorted, no timestamps/random): model fingerprint + per-schema breakdown + node-id hash, graph order/size, analysis (cycles/islands/hubs/orphans/longest-path), reachability + up/down trace from a deterministic origin, shortest path, and fixed search queries.
- **Single golden file:** `tests/fixtures/engine-parity-baseline.json`.
- **Unit layer** ([tests/unit/engine-parity.test.ts](../tests/unit/engine-parity.test.ts)) computes the report from the fixture and asserts `== baseline`.
- **Electron layer** ([tests/integration/engine-parity.test.ts](../tests/integration/engine-parity.test.ts)) loads the demo in the real EDH, calls the gated `dataLineageViz.__test.engineReport` command (registered only under `VSCODE_EX_TEST`; returns the report), and asserts the report **byte-matches the same baseline**.

The payoff: **unit-pass + electron-fail = an integration/bundling/extraction regression** — invisible to isolated unit tests, caught here. Intentional output changes are vetted, then the baseline is regenerated and the diff reviewed:

```
npm run test:parity:update   # regenerate tests/fixtures/engine-parity-baseline.json
```

This follows the project's existing golden-baseline discipline (`aw-baseline.tsv` via `test:snapshot:update`, `graph-baseline-aw.json`). Golden tests verify **consistency, not correctness** — the baseline was vetted once against those already-verified baselines.

## Sub-agent orchestration (fan-out)

Test **authoring** is parallelized across **Sonnet** sub-agents; an Opus **lead-test-manager** orchestrates. The rules:

- **Model:** sub-agents run on **Sonnet** (cost-effective for mechanical authoring); the orchestrator runs on Opus.
- **Concurrency cap: max 3 sub-agents at once.** Author in batches of ≤3; start the next batch only after the current one returns. Keeps review tractable and avoids file-write races.
- **One scoped suite per agent.** Each agent owns a single test file (plus, at most, an additive extension of one shared helper). Two agents never edit the same file in a batch.
- **Contract-first brief.** Each agent is told to read the real source (`bridgeContract.ts`, the handler, `extension.ts` config logic) before writing, and to assert against the real Zod schema / API — never a hand-copied shape. A spec that passes by weakening an assertion is rejected.
- **Author + type-check only, never launch the GUI.** Agents verify with `npx tsc -p tsconfig.integration.json --noEmit` (no emit → no parallel `out/` races). They do **not** run `npm run test:integration` (it opens an EDH window — that is the orchestrator's serial step).
- **Orchestrator owns the green bar.** After a batch returns, the orchestrator compiles once, runs the headed EDH suite **serially** (one window, steals focus), then triages each failure as **product-bug** (fix source, root-caused) vs **test-bug** (fix spec) vs **contract ambiguity** (escalate), and re-runs to green. All verdicts are read from logs/dumps, so runs are scriptable and re-checkable.

## Running

```
npm run typecheck            # L0: tsc --noEmit
npm test                     # L1: vitest (unit + engine-parity baseline assert)
npm run test:integration     # L2+L3: @vscode/test-electron via .vscode-test.mjs (incl. electron parity)
npm run test:parity:update   # regenerate the engine-parity golden baseline (after a vetted change)
```
Env: `VSCODE_EX_TEST=1` enables `testLogCapture` and the gated `__test.engineReport` command; `--remote-debugging-port=9222` (in `.vscode-test.mjs` `launchArgs`) enables the CDP read; `--logsPath <dir>` to capture host log files.

CI runs all of the above on every PR/`main`/`testing` push ([.github/workflows/ci.yml](../.github/workflows/ci.yml)): a matrix of Ubuntu + Windows, `xvfb-run -a` wrapping the EDH run on Linux, with the VS Code download cached. Green CI = no regression in the backend behind the GUI.
