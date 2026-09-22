# Open task list — testing05 → 1.2.0 (handover 2026-09-21 22:10)

HEAD has this session's fixes through `c8964a0f9`; peer commits on top (comment trim batches,
`d5b2bba1c` shared SQL comment scanner). Last full agg: `agg-146385100` GATE PASS vs main
`20356737e` and prev `45cc1ab49`. Working tree is NOT clean and NOT this session's: peer
`testing05-code-review-fixes` (src comment pass) and `vscode-data-lineage-f3` (PM-ordered AI-runtime
test trim under tests/unit/sm, tests/unit/ai-core — uncommitted until the PM asks).

**Pre-capture `m61-pre-azure` at `c8964a0f9` — full set, GATE PASS vs main `20356737e` AND prev
`45cc1ab49`** (`test-results/facts/agg-c8964a0f9-azure-foundry.json`, 7/9 questions green, facts
69/71, blocking 0, MISSING none). T8 8/8 must — first full pass since 850e4caf2 (reopen fixes). T6
`negative_qty_clamp` = quarantined FLIP; T7 `unitprice_zero_fallback` red at both refs (never blocks).
Q25 BB-parity 11/11. Not baselined, not pushed: open items below first (PM goal). Peer `testing05-code-review-fixes`
is DONE (comment batches 1–7 through `038c151be` pruneOriginForbidden + bridge types);
the final capture runs at the HEAD after O1/O2/O4. Peer `vscode-data-lineage-f3` test trim
committed as `7de34c444`.

**History rewritten 2026-09-22** (170 → 30 commits, force-pushed): shas cited below before `d5b2bba1c`, and every `agg-<sha>` capture, are pre-rewrite. They stay resolvable through `refs/backup/testing05-pre-squash` — never delete that ref, `factcheck.py history` resolves each agg sha with `git show`. `git log --grep <old-sha>` finds the combined commit.

## Open — next session, in this order

| # | Item | State | Next |
|---|---|---|---|
| O1 | Follow-up stop `Detail slot(s) reached no section` (m60 19-13-06 only; other 2 recordings do not reproduce) | hop read DONE 2026-09-22: kept nodes, no prompt contradiction — convergent repair 12→7→2 killed by `MAX_TOOL_SEMANTIC_FAILURES=3` (`toolAttempt.ts:60`, charge sites ~1808/1843/1894); issue `followup-prune-slots` | CODE owner: a validation reject whose violation set is a strict subset of the prior attempt's is not charged; red→green in `tool-attempt.test.ts`. fix in flight 2026-09-22 (uncommitted in `toolAttempt.ts` + `tool-attempt.test.ts`; try-1 rejected — slot rejection carries fixed path `sections`, so the shrink exemption never fired; try-1b makes violations carry entry ids). If found uncommitted in a new session: verify red→green reproduces the real present_result slot rejection before committing, else discard |
| O1b | Harness `--followup` (repeatable) in `internal-tests/tools/e2e-run.mjs` + harness — written by the agent, untracked internal-tests | builds (tsc exit 0, 2026-09-22) | reuse for O2/O4 |
| O2 | Playground proof owed for follow-up wording `a4e7d559e`, `d73db5898` | on an O1 follow-up recording | one pair each |
| O4 | `follow-up-explore-next-autosupplement` — headless only (row no-pm-retest) | headless run + O2 playground pairs in flight 2026-09-22 (one agent; results → issue `follow-up-explore-next-autosupplement`) | `--followup "Explore related objects"` then a pick: turn 2 lists + asks, turn 3 supplements |
| O5 | `ct-edge-transform-classes` (`c3c2babde`) | measured by final capture | close on capture |
| R1 | Code-review cleanup rest (plan `~/.claude/plans/robust-popping-dusk.md`) | DONE 2026-09-22 | landed: comment batches 1–7, `038c151be`, `03fbf7fa9` columnTraceDirection/required traceDirection/runStore trunc, `03fbf7fa9` + `03fbf7fa9` sm/session comment pass, `03fbf7fa9` useTraceNeighborPicker + GraphCanvas latest-refs (no render test: React Flow needs browser APIs jsdom lacks), `03fbf7fa9` toolErrorEnvelope. Closed no-change: `modelSearch` sweep merge (+16), `tools.ts` regex guard (+12), `toolAttempt` (+5), `memoryManager` (+7), generic `nodeDecoration` memo (−4, less readable). Left: large-function splits, after the green baseline, one per commit |
| H1 | `bad_contributor_col` hint states a READS-only rule the validator enforces for procedures only (`columnTracer.ts:467`, `smRouteValidation.ts:35`) → wrong repairs, extra rejections | OPEN, issue `bad-contributor-col-hint-scope` | model-facing text: hop read of a run that hit it (`rendered_prompt.py find "bad_contributor_col" <run>`) → owner; prompt owner → one-pair playground → `/prompt-change`; primary item (rejection reduction) |
| H2 | Four "analysis is held" templates in inconsistent format (`smCompleteness.ts:75`, `smRouteValidation.ts:78,85,101`) | OPEN, secondary | wire text changes → only with hop evidence + playground; not before H1 |
| S1 | Large-function split (PM-approved 2026-09-22) | `submitFindings` DONE `the `applyValidatedHop` commit` (apply phase → `applyValidatedHop`; gate 14/14, vitest 2685/2685, EDH 4 lanes 17/17) | next, one commit each: `executePresentResult` repair-draft branch (`presentResult.ts:234`), then `executeToolGenerationAttempt` tool-call loop (`toolAttempt.ts:1735`, after the O1 edit there lands); same proof: coverage of the moved range first, then tsc + suites |
| L2 | New green baseline | after O1/O2/O4 + peer sessions done | `capture_wt.py <label> --lane azure-foundry --prompts T2,T3,T4,T5,T6,T7,T8,T8S,T25 --parallel 3 --against test-results/facts/agg-45cc1ab49-azure-foundry.json` (sandbox off; clean the capture worktree first if pin fails) → compare both → `baseline`, commit, push |

## Done this release

`146385100` continuation schema names the carrier side · `448c4db7c` downstream CT crosses a
derived column (smoke m59 ok) · `611c212ad` classification-lock hint names the missing angle ·
`d67c44783` question-shaped example removed from `prompts.ts:299` (agnostic test) · `c8964a0f9`
CT reopen credited its archived angles, one rejection names every gap · Q25 price callout closed
SPORADIC (bonus only) · T8 SUM/dedup loss traced to the reopen rejection chain (fixed above).
Earlier: A1 `.muse` out of VSIX `3ee3db61a` · A3 loader via `validateBridgeFrame` `ca650597e` ·
R1 release verification `6d6784712`. · T1 AI-runtime test trim closed at pass 2 (`7de34c444`, `a1fac73c9`; 0 coverage lost; regression tests kept, row regression-tests-kept) · `coverage:core` green again `03fbf7fa9`.
Code-review follow-ups 2026-09-22: A4 parser cap now reported `a1fac73c9` · A5 trace/SM-dump dirs git-ignored `a1fac73c9` · B7 one tool-name spelling `a1fac73c9` · B8 unexported `a1fac73c9` · traceDirection required `a1fac73c9`.

## Backlog (not this release)

(empty)

## Closed — no change (re-raise only with new evidence)

B6 `prunedDetails` kept: archive awaiting an approved read path, used as the prune oracle by 3 tests · A2 render-state deps · B1 DACPAC decompression cap · B2 longest-path O(k²) · B3 `load-project` path
check · B4 `]]` in CTE bracket skip · B5 edge dedup ignores type · A6 trace-write catches (already
reported via `onWriteFailure`, `extensionRuntime.ts:82-86`) · B9 cosmetics.
