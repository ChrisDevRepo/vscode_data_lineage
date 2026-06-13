# Code Review Cleanup & Monolith Split — Summary

Branch: `claude/code-review-cleanup-038ish`. This document records the review-cleanup
changes and the first monolith split, with before/after line counts. (Process doc — safe to
delete after review.)

## Part 1 — Review cleanup (correctness, feedback, hygiene)

All behavior-preserving except the two user-facing feedback fixes. Verified by `tsc` strict,
167 unit + 2 baseline + 1 snapshot tests, golden artifacts unchanged, and two cross-check agents.

| Area | Change | Files |
|---|---|---|
| Correctness | Decoupled `skipLayout` from `forceLayout` (Schema View no longer falls back to Dagre on sync rebuild) | `components/App.tsx` |
| Feedback | Failed webview actions now show an error notification (was silent) | `panelProvider.ts` |
| Feedback | Built-in AI-template / parse-rule load failures now warn the user | `extension.ts` |
| Root-cause cleanup | Removed redundant dead `overview-mode-changed` channel (graphMode already synced via `filter-changed`) | `App.tsx`, `messageHandlers.ts`, `bridgeContract.ts` |
| Hardening | Single-source `OBJECT_TYPES` (type + zod schema); projection validates node type vs blind cast | `engine/types.ts`, `schemaProjection.ts`, `bridgeContract.ts` |
| Hardening | `save-view` validates persistence-critical fields; `render-state` → `z.unknown()` | `bridgeContract.ts` |
| Stale code | Renamed `expandedSchemaViewCore.test.ts` → `schemaProjection.test.ts` (+ runners, README) | `tests/**` |
| JSDoc | Corrected/added docs (rebuild, LineageFlowNodeSource, traceScope, ModeCapabilities, maxNodes, log.ts) | various |

Settings audit: all 37 declared settings are read; every read is declared; `DEFAULT_CONFIG`
matches package.json defaults — no unimplemented or stale settings.

## Part 2 — Monolith split (pilot): `tools.ts`

Extracted the AI tool **input-contract schemas** out of the operations file into a dedicated
module. Pure move — importers point directly at the new module (no re-export shim).

### Line counts before / after

| File | Before | After | Δ |
|---|---:|---:|---:|
| `src/ai/tools/tools.ts` | 1600 | 1358 | −242 |
| `src/ai/tools/toolSchemas.ts` (new) | 0 | 250 | +250 |
| `src/ai/tools/toolProvider.ts` | 1103 | 1105 | +2 (import split) |
| `tests/unit/start-exploration-schema.test.ts` | — | — | import retargeted |
| `tests/unit/submit-findings-schema.test.ts` | — | — | import retargeted |

Moved to `toolSchemas.ts`: `StartExplorationInputSchema`, `GetScopeBundleInputSchema`,
`SubmitFindings{Bb,Ct,}InputSchema` (+ shared section/route/column-flow schemas),
`GetNeighborColumnsInputSchema`, `validateToolInput`, and their inferred types.

### Verification protocol (before → after, both green)

- `tsc --noEmit` clean
- `npm test` 167/167, `test:baseline` 2/2, `test:snapshot` 1/1
- golden artifacts (`graph-baseline-aw.json`, `aw-baseline.tsv`) byte-unchanged
- independent AI agent cross-check: pure move, no regression

## File-size landscape & next cuts

Industry norm: <400 ideal, 400–800 watch, >1000 split-candidate. This repo has 9 files >1000
lines, concentrated in the AI subsystem.

| File | LOC | Next action |
|---|---:|---|
| `ai/sm/smBase.ts` | 2151 | large by nature (state machine); extract route-validation + diagnostics helpers only |
| `ai/participant/lineageParticipant.ts` | 1869 | extract pure helper block (compaction/extractors, ~460 LOC) |
| `components/App.tsx` | 1559 | extract effect clusters into hooks |
| `components/GraphCanvas.tsx` | 1409 | extract effect clusters |
| `ai/tools/tools.ts` | 1358 | **extract present-result/view-assembly cluster (~430) → `presentResult.ts` → ~930** |
| `engine/graphBuilder.ts` | 1111 | split `graphLayout.ts` + `traceFlow.ts` |
| `ai/tools/toolProvider.ts` | 1105 | split the large `startExploration`/`submitFindings` handlers |
| `bridge/messageHandlers.ts` | 1042 | split handler groups (project/view, db/stats, dacpac) |

Guardrail: target the >1000 outliers and aim for cohesive ~400–700-line modules; do not chase
every file under 300 — that is churn without payoff. Each split ships as its own move-only PR
under the verification protocol above.
