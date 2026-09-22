# Open task list — testing05 → 1.2.0 (handover 2026-09-21 22:10)

HEAD has this session's fixes through `c8964a0f9`; peer commits on top (comment trim batches,
`51d5a3d0a` shared SQL comment scanner). Last full agg: `agg-146385100` GATE PASS vs main
`20356737e` and prev `45cc1ab49`. Working tree is NOT clean and NOT this session's: peer
`testing05-code-review-fixes` (src comment pass) and `vscode-data-lineage-f3` (PM-ordered AI-runtime
test trim under tests/unit/sm, tests/unit/ai-core — uncommitted until the PM asks).

**Pre-capture `m61-pre-azure` at `c8964a0f9` — full set, GATE PASS vs main `20356737e` AND prev
`45cc1ab49`** (`test-results/facts/agg-c8964a0f9-azure-foundry.json`, 7/9 questions green, facts
69/71, blocking 0, MISSING none). T8 8/8 must — first full pass since 850e4caf2 (reopen fixes). T6
`negative_qty_clamp` = quarantined FLIP; T7 `unitprice_zero_fallback` red at both refs (never blocks).
Q25 BB-parity 11/11. Not baselined, not pushed: open items below first (PM goal). Peer `testing05-code-review-fixes`
is DONE (comment batches 1–7 through `8a77d78bb`, `d951a7616` pruneOriginForbidden + bridge types);
the final capture runs at the HEAD after O1/O2/O4. Peer `vscode-data-lineage-f3` test trim
committed as `c305d5da4`.

## Open — next session, in this order

| # | Item | State | Next |
|---|---|---|---|
| O1 | Follow-up prune: `prompts.ts:455-459` "omitted section is a deleted section" contradicts retain contract `toolSchemas.ts:946` (825d1cc27); harness follow-up m60 also stopped 3× `Detail slot(s) reached no section: spimportorders, vwexternalorders` (`test-results/e2e/m60-followup-prune/2026-09-21T19-13-06-929Z-azure-foundry/run-1/host.log:295-296`) | package `/tmp/prune-reauthor-package.md`; agent was mid hop read of 2nd recording `…19-43-59-594Z…` | were the two nodes pruned (engine demands slots of pruned nodes → code) or kept (prompt contradiction → one-pair screen at the follow-up gen) |
| O1b | Harness `--followup` (repeatable) in `internal-tests/tools/e2e-run.mjs` + harness — written by the agent, untracked internal-tests | verify it builds (`npx tsc -p internal-tests/tsconfig.integration.json`) | reuse for O2/O4 |
| O2 | Playground proof owed for follow-up wording `a4e7d559e`, `d73db5898` | on an O1 follow-up recording | one pair each |
| O4 | `follow-up-explore-next-autosupplement` — headless only (row no-pm-retest) | not run | `--followup "Explore related objects"` then a pick: turn 2 lists + asks, turn 3 supplements |
| O5 | `ct-edge-transform-classes` (`c3c2babde`) | measured by final capture | close on capture |
| R1 | Code-review cleanup rest (plan `~/.claude/plans/robust-popping-dusk.md`; comment batches 1–7 + `d951a7616` landed) | stopped on the usage limit | `smBase.ts`/`session`/`sm` comment pass was partial; open: `columnTraceDirection()` ×4 in `smBase.ts`, required `traceDirection`, `runStore.ts:112` `trunc`, `GraphCanvas.tsx:1097` refs + test, de-dup of `searchBodyScripts` regex branch, `tools.ts` regex guard, `toolAttempt`/`toolErrorEnvelope`/`nodeDecoration`/`memoryManager` helpers, `useTraceNeighborPicker`; each proven by `assert-comment-only.mjs` or the unit suites |
| T1 | AI-runtime test trim (PM 2026-09-21): pass 1 committed — 17 files folded or deleted, 0 lost `src/**` coverage; stopped on the usage limit, far short of the ≥40% target | pass 2 open | per-file unique coverage (0-unique files are the candidates: rerun the per-file coverage map); fold each red→green proof's decisive assertion into its owner file; biggest targets are `tool-attempt.test.ts`, `column-flow-validation.test.ts`, `ct-retention-differential.test.ts`, the `navigation-engine-*`, `prune-*`, `present-result-*` and `completion-envelope-*` families; parser/engine never |
| R2 | Register row owed — `.claude/skills/…/rulings-register.md` is write-denied to the agent (sandbox + auto-mode classifier), PM pastes it | not written | append after row `no-pm-retest`: `\| 2026-09-21 (parser-signoff-testing05) \| **The testing05 parser changes are signed off — removeBlockComments string/quote/bracket/line-comment skipping, resolveComputedColumnTypes, and the ]]/"" escapes in sqlRegex.ts — and search and parser share one SQL comment scanner.** \| IN FORCE \|` |
| L2 | New green baseline | after O1/O2/O4 + peer sessions done | `capture_wt.py <label> --lane azure-foundry --prompts T2,T3,T4,T5,T6,T7,T8,T8S,T25 --parallel 3 --against test-results/facts/agg-45cc1ab49-azure-foundry.json` (sandbox off; clean the capture worktree first if pin fails) → compare both → `baseline`, commit, push |

## Done this release

`146385100` continuation schema names the carrier side · `448c4db7c` downstream CT crosses a
derived column (smoke m59 ok) · `611c212ad` classification-lock hint names the missing angle ·
`d67c44783` question-shaped example removed from `prompts.ts:299` (agnostic test) · `c8964a0f9`
CT reopen credited its archived angles, one rejection names every gap · Q25 price callout closed
SPORADIC (bonus only) · T8 SUM/dedup loss traced to the reopen rejection chain (fixed above).
Earlier: A1 `.muse` out of VSIX `3ee3db61a` · A3 loader via `validateBridgeFrame` `ca650597e` ·
R1 release verification `6d6784712`.

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
