# Open task list — testing05 → 1.2.0 (updated 2026-09-21)

HEAD `6d6784712` · gate 14/14 · build + VSIX (78 files) + EDH 4/4 green · queue: 1 running, 0 ready.
Last measured: `agg-607ef7140-azure-foundry.json` — GATE INCOMPLETE (7/8 green, 0 blocking, T8 = 2
quarantined flips, Q25 not run). Baseline: `agg-45cc1ab49-azure-foundry.json`; main `20356737e`.

## Open

| # | Item | State | Next |
|---|---|---|---|
| L1 | `ct-continuation-schema-mismatch` — served schema says continuation "at its writers" (`toolSchemas.ts:596,625`); validator enforces carrier side, readers on a downstream trace (`columnTracer.ts:280,389-410`) | agent running; package → `/tmp/ct-continuation-schema-package.md` | playground PASS → apply wording + golden refresh; FAIL → close, no edit |
| L2 | New green baseline | owed after L1 | one full-set azure capture at final HEAD (T2–T8S + Q25) → `compare` vs main and `45cc1ab49` → PASS → `baseline`, commit, push |

## Done this release

A1 `.muse` out of VSIX `3ee3db61a` · A3 loader via `validateBridgeFrame` `ca650597e` · R1 release
verification at `6d6784712` (gate 14/14, VSIX 78 files, EDH 17 passing).

## Backlog (not this release)

- A4 parser 10,000-match cap unlogged (`sqlBodyParser.ts:568`) — report in parse stats; protected tier.
- A5 AI trace / SM dumps in `<workspace>/tmp/` unguarded (`commands.ts` ~92) — write `tmp/.gitignore`.
- B6 `AiMemoryManager.prunedDetails` written, never read — wire a reader or drop the write.
- B7 tool name logged two ways (`toolProvider.ts`) — one spelling; check trace-tool keys first.
- B8 `FULL_RESUBMIT_ORDER`, `isContentKind` exported unused (`smRouteValidation.ts`) — drop `export`.

## Closed — no change (re-raise only with new evidence)

A2 render-state deps · B1 DACPAC decompression cap · B2 longest-path O(k²) · B3 `load-project` path
check · B4 `]]` in CTE bracket skip · B5 edge dedup ignores type · A6 trace-write catches (already
reported via `onWriteFailure`, `extensionRuntime.ts:82-86`) · B9 cosmetics.
