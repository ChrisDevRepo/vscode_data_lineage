# Open task list — testing05 → 1.2.0 (updated 2026-09-21)

HEAD `d67c44783` · gate 14/14 · last measured `agg-146385100-azure-foundry.json` GATE PASS vs main
`20356737e` and prev baseline `45cc1ab49`. Full-set rerun waits for the peer session's code, then runs
once at the final HEAD (PM 2026-09-21).

## Open

| # | Item | State | Next |
|---|---|---|---|
| O1 | `follow-up-prune-reauthor` — `prompts.ts:455-459` "omitted section is a deleted section" contradicts retain contract `toolSchemas.ts:946` | agent: harness `--followup` + one-pair screen | PASS → apply wording, golden refresh, commit |
| O2 | Playground proof owed for follow-up wording in `a4e7d559e`, `d73db5898` | waits on O1 harness | one pair each on the recorded follow-up gen |
| O3 | Revisit angle-lock + double rejection per bad submit (T8 reopen, m57 host.log:176-187) | agent running | red→green → commit |
| O4 | `follow-up-explore-next-autosupplement` | verify headless (row no-pm-retest): `--followup "Explore related objects"` then a pick on the O1 harness | folds into O2 capture |
| O5 | `ct-edge-transform-classes` (`c3c2babde`) | measured by the final capture | close on capture |
| L2 | New green baseline | after O1–O3 + peer code | full-set azure capture → `compare` vs main and `45cc1ab49` → `baseline`, commit, push |

## Done this release

Solved this session: `ct-continuation-schema-mismatch` `146385100` · `ct-downstream-derived-column` `448c4db7c` (smoke m59 ok) · T8 reopen rejection hint `611c212ad` · overfit example removed `d67c44783`.

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
