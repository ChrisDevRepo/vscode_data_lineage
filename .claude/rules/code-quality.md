# Code Quality Rules

## Error Reporting

Report all errors/warnings in touched areas — even unrelated to the current task. Includes `tsc --noEmit`, build, test, lint. Cite file:line.

## Type Safety

- Run `tsc --noEmit` after structural changes
- Keep `ObjectType` union and `Record<ObjectType, ...>` maps in sync
- Export shared types (e.g. `CustomNodeData`) — don't duplicate
- Prefer `type` over `interface` when satisfying `Record<string, unknown>` (React Flow generics)

## General Quality

- No magic numbers — use `DEFAULT_CONFIG` from `types.ts`
- No speculative types — YAGNI
- No pre-release deps
- Decompose functions at >100 lines
- Inline docs follow [`inline-docs.md`](inline-docs.md)

## Parser Rule Change Verification (MANDATORY)

After **any** change to `assets/defaultParseRules.yaml`, run committed snapshot. Zero regressions. One change at a time.

```bash
npm run test:snapshot         # exits 1 on diff vs tests/fixtures/aw-baseline.tsv
npm run test:snapshot:update  # only after diff is verified intentional
```

Dep lost = REGRESSION (blocked). Dep gained = verify before `:update`. Document in `tmp/working-task.md`. Snapshot covers all 31 SPs across 2 dacpacs — unit tests alone are NOT sufficient.

## Test Script Integrity

All test files under `tests/unit/*.test.ts`. Two scripts in `package.json`:
- `npm test` — full suite (parser, dacpac, graph, DMV, AI tool registration, SM robustness)
- `npm run test:unit:ai` — heavy AI tests (iterated independently)

When adding a test: add to the right script, update counts in `.github/copilot-instructions.md` + `tests/README.md`, verify both run clean.

## Compilation Gate

After EVERY structural change (move/rename/extract): `tsc --noEmit` before proceeding. Never accumulate type errors across commits.

## Refactoring Test Order

Run baseline tests → extract/move → re-run tests → only delete tests AFTER refactored code passes them.

## Pre-Package Hygiene (Windows)

Before `vsce package`: check for reserved-name artifacts (`nul`, `CON`, `AUX`, `PRN`, `COM1-9`, `LPT1-9`) via `npx @vscode/vsce ls`. Already gitignored but verify.

## State Management & Control Flow

Default pattern: **typed discriminated unions + exhaustive `switch`**. Boolean flag pileup is the anti-pattern.

- Prefer `type X = { kind: 'a' } | { kind: 'b'; payload: ... }` over optional-boolean bags
- Exhaustive `switch` on discriminator — adding a variant makes `tsc` flag every missing case
- Loops with >1 exit reason return a discriminated-union exit type (canonical: `HopLoopExit`), not `void`
- Transitions go through methods (`enterX()`), not direct field mutation
- Zod at boundary; inner layers consume parsed type
- No guards for structurally-prevented bugs — hides the real invariant

## Mechanical Enforcement Over Prompt Language

For AI-facing code: vague prompt rules ("you must…", "prefer…", "when appropriate…") are contract debt — models drift under pressure. If an invariant matters, enforce in code.

**Rule:** before adding a prompt sentence like "you must X", check if a mechanism (Zod, FSM, `LanguageModelChatToolMode.Required`, engine route validation, tool filter, etc.) can enforce it. If yes, use the mechanism and delete the sentence.

**Legitimately prompt-owned:** analysis quality, verdict judgment, tone, wording. Prompts describe intent; code enforces contracts.

Full invariant→mechanism table: [`_reference/mechanical-enforcement-table.md`](_reference/mechanical-enforcement-table.md).

## Rejection Policy — Mechanical Contracts Only, Never Content

We are a data provider. Don't reject the model because the prompt was weak.

- **Reject on:** datatype, char-length, invalid object refs (unknown id, out-of-filter schema, past depth), malformed structure (unclosed fences, missing required field)
- **Never reject on:** prose length, compression ratio, summary depth, narrative completeness, tone, label nuance

**Test:** if a rejection can't be framed as "type / length / identifier / structure violation", it belongs in the prompt.

**Why:** content-quality rejections create retry loops the AI can't escape when legitimate output lands below an arbitrary floor — paraphrase, give up, emit payload as chat prose. `[2026-04-18]` compression check in `viewSynthesisService.ts` blocked present_result 3× per click — never reintroduce.

## Column Trace (CT) — Mechanical Enforcement Rules

CT is a structural contract. These rules are enforced in `smBase.ts`, not prompt prose.

**Mode guard.** CT forces SM: `shouldSmInline` returns false when `targetColumns` is set; `forceMode` overrides inline regardless of scope size.

**Binary gate.** Every non-prune `submit_findings` when CT is active must carry `column_flow[]` with at least one entry. Missing `column_flow` → `column_flow_required` rejection. The hint echo-backs the fields that were received and are correct, then demands additive completion.

**Rejection codes:**
- `column_flow_required` — non-prune verdict submitted without `column_flow`
- `column_flow_validation_failed` — `column_flow` present but schema-invalid (Zod)
- `ct_requires_sm` — CT exploration attempted in inline mode (guard fires before engine)

**`filter_only` excluded.** Edges with `role="filter_only"` are accepted by the schema but never accumulated in `ColumnAspect.edges[]` — they are WHERE/JOIN-ON predicates, not data-output contributors.

**`writes_to` redirect.** Writer procedures set `writes_to: { node, col }` to resolve edge direction away from `focusId` and toward the target table column. `out_col` = the column name in the target table (same as `writes_to.col`). Role: `formula`/`case`/`coalesce`/etc. for computed expressions; `rename` for direct pass-through. Execution parameters (`@StartDate`, `@Mode`, etc.) have no role in `column_flow` — they are filter/control inputs, not data-column sources. Capture their business/technical effect in `sections[].text` only.

**Column validation gates (smBase.ts).** `out_col` existence check is skipped for procedure focus nodes — procedures write columns to tables; their DDL body does not expose those column names as owned metadata. `from_col` existence check is skipped when the contributor is a procedure or function — `parseProcParams` returns execution @params, not data-column names; the check would always produce false negatives. Tables and views are readers with verifiable column schemas and are always validated. `validateNeighborIds` lowercases input IDs before checking `scopeNodeIds` and `directNeighbors` (engine-internal keys are lowercase).

**`structural_summary` template.** Fires only when the focus node is non-bodied (a table — no DDL). Replaces `business_capture`/`technical_capture` at that hop. On all other hops (view, procedure, function focus), `structural_summary` is gated out and the normal capture templates fire. Gated in `templateRenderer.ts` via `focusIsNonBodied` flag passed from `lineageParticipant.ts`.

**Lineage sub-questions.** `getColumnLineageQuestions()` generates per-column chain-continuation questions from `ColumnAspect.edges[]` accumulated so far. Injected as `<lineage_questions>` in the next hop's `<current_task>` block, labeled PRIMARY follow-up.

**Active-column derivation + CT auto-prune (smBase.ts dequeue loop).** `route_requests.columns` is optional — AI may omit it. At dequeue time, if `candidate.activeColumns` is empty, the engine recovers it from `_columnAspect.edges.filter(from_node === nodeId).map(from_col)`. If derivation also yields nothing, the node is auto-pruned by the engine (visited + prune tally + debug log, no AI call). This prevents inescapable rejection loops when the AI omits `columns` on route_requests.
