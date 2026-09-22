# Open task list (2026-09-21, pre-release review of testing05 → 1.2.0)

Source: six-area pre-release review (GUI, core engine, backend AI, middleware, VS Code extension,
security), re-scored by likelihood × impact; plan approved by the PM 2026-09-21. Baseline before
edits: typecheck clean, 2677/2677 unit tests, VSIX 630 files (555 from `.muse/`).

## Open

| # | Issue | Solution | Origin | Effort | Risk | Test | State |
|---|---|---|---|---|---|---|---|
| A1 | VSIX packaged `.muse/worktrees/**` (555/630 files, 9.6 MB internal source) | `.muse/**` in `.vscodeignore`, `.muse/` in `.gitignore`, `.muse` in the package-contents gate guard | main | S | Low | `assert-package-contents.mjs` red → green; VSIX 630 → 75 files | DONE `3ee3db61a` |
| A3 | `useDacpacLoader.ts` hand-rolled safeParse + version check; `App.tsx`/`DetailApp.tsx` already use `validateBridgeFrame` | Loader listener routed through `validateBridgeFrame` | branch | S | Low | `bridge-protocol-version.test.ts`: one-home test red → green; suite 2690/2690 | DONE `ca650597e` |
| R1 | Release verification after A1/A3 | `npm run gate`, `npm run build`, `npm run package` + VSIX list check, one `npm run test:edh` smoke | — | S | — | gate PASS | OPEN — run once the in-flight SM/CT work is committed and the tree is green (`typecheck:tests` currently fails in that session's new test file) |

## Backlog (not this release)

| # | Issue | Solution | Origin | Why deferred |
|---|---|---|---|---|
| A4 | Parser stops after 10,000 matches of one rule on one body (`sqlBodyParser.ts:568`) with no log | Report the cap hit in parse stats, like `droppedRefs` | main | Near-zero likelihood; protected parser tier |
| A5 | AI trace / SM dump files in `<workspace>/tmp/` with no ignore guard (`commands.ts` ~92) | Write `tmp/.gitignore` (`*`) on enable; warn in the notification | main | Low likelihood (three conditions); content usually already in the SQL project repo |
| B6 | `AiMemoryManager.prunedDetails` is written but never read in production | Wire a reader or remove the write path | main | Existing debt, not a defect |
| B7 | Tool names logged as `lineage_get_context` on reject, `get_context` on success (`toolProvider.ts`) | One spelling per tool | main | Internal trace tooling may key on names; check before changing |
| B8 | `FULL_RESUBMIT_ORDER`, `isContentKind` exported but unused (`smRouteValidation.ts`) | Drop `export` | branch | Fold into the in-flight commit on that file |

## Closed — no change (do not re-raise without new evidence)

- A2 render-state effect deps (`GraphCanvas.tsx:1586`): every add/prune changes `localNodes` → `traceControlsByNode` → effect re-runs; no stale path.
- B1 DACPAC decompression cap: Microsoft-produced, metadata-only file picked by the user; worst case is a recoverable extension-host crash.
- B2 longest-path O(k²) per SCC: SQL dependency cycles are a handful of nodes.
- B3 `load-project` path check: needs a webview compromise first; CSP + DOMPurify, none found.
- B4 `]]` inside a CTE bracket skip: needs `]]` plus a parenthesis in one identifier.
- B5 edge dedup ignores type: body and exec edges never share a source/target pair.
- A6 "silent" trace-write catches in `lineageRuntime.ts` — REFUTED-NO-DEFECT: `AiTraceWriter` already reports every write failure through its `onWriteFailure` handler (`extensionRuntime.ts:82-86`, warn once then debug); the runtime catches only stop a duplicate unhandled rejection. Logging there would double-log.
- B9 cosmetics: magic `52` px offset, duplicated merged-ref callback, import order in `schemaProjection.ts`.
