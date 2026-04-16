# Senior Engineer Recommendation: Refactoring Branch Review

**Author role**: Senior Software / AI / Testing Engineer  
**Date**: 2026-04-16  
**Branch**: `refactor/inspection-findings-2026` vs `main`  
**Audit basis**: 302 features inventoried, 6 Opus agent runs, 14 findings, all CRITICAL findings double-verified

---

## 1. ROOT CAUSE ANALYSIS

The 14 findings cluster into three systemic failure modes. Fixing individual findings without addressing root causes will leave the codebase vulnerable to the same class of errors on the next refactoring pass.

### Failure Mode A: Large-batch refactoring without incremental compilation gates

FINDING-001, 002, 003 (CT init missing assignments) and FINDING-009, 010 (App.tsx/useAppState build breaks) share the same cause: code was restructured in bulk, and `tsc --noEmit` was not run between steps. The CT init() function was rewritten — two assignment lines and a validation block were dropped without the compiler catching it, because the class fields have defaults (`direction = 'up'`, `targetColumns = []`) that satisfy the type checker even when never assigned from params.

**This is the most dangerous class of refactoring bug**: the code compiles, the types are satisfied, but runtime behavior is silently wrong. TypeScript's type system cannot catch "field declared with default, never overwritten from input." Only tests or manual tracing can.

### Failure Mode B: Test deletion before refactoring verification

The 5 Vitest hook test files (1647 lines) were deleted in the same branch that restructured the code they tested. This is backwards — tests should be the last thing removed, not the first. The CT init regression (FINDING-001, 002) would have been caught immediately by the existing `columnTraceState` tests if they still existed.

The test deletion also explains why the branch was committed with 11 tsc errors — there was no automated gate running `tsc --noEmit` as part of the test pipeline.

### Failure Mode C: Mechanical consolidation without semantic verification

FINDING-011 (FROM_TERMINATOR_RE regex bug) happened because regex patterns were moved from inline to shared module using a mechanical approach: put terminators in an array, join with `\b|`. The author didn't verify that the generated regex string matched the original. The original had `\b` only on keyword terminators (WHERE, JOIN, etc.) and omitted it on punctuation terminators (`;`, `)`, `$`). The new code adds `\b` to all.

This is a common consolidation anti-pattern: "extract to DRY" introduces a bug because the consolidation logic doesn't preserve all semantic distinctions of the original inline code.

---

## 2. WHAT THE REFACTORING GOT RIGHT

Before recommending changes, it's important to acknowledge that the architectural direction is correct and the majority of the work is sound:

- **130/130 features from the original extension.ts are accounted for**. Zero features were lost at the module level. The decomposition mapping is complete.
- **89 features are byte-for-byte IDENTICAL** in their new locations. The extraction was careful.
- **Dependency injection replaces globals**. The `AiSession` singleton + DI params is a textbook improvement over 15+ module-level `let` variables.
- **`AiMemoryManager` encapsulation** correctly extracts the two-tier memory model without changing its semantics. The same limits (500 soft / 1200 hard) are preserved.
- **`BridgeHost` abstraction** in panelProvider.ts enables future testability of IPC handlers without VS Code runtime.
- **All 27 webview message handlers** are preserved with identical logic.
- **All 13 AI tool handlers** are preserved (1 changed: enrich_view delegates to ViewSynthesisService, which is a clean extraction).

The decomposition from 3477 lines to 12 focused modules is a significant maintainability win. The problems are localized to a few functions, not systemic to the approach.

---

## 3. RECOMMENDATION: STAGED FIX PLAN (not hotfixes)

The findings should be fixed in discrete, verifiable commits — not batched into a single "fix everything" commit. Each commit must pass `tsc --noEmit` before the next begins.

### Stage 1: Restore compilation (FINDING-008, 009, 010, 014)

**Goal**: `tsc --noEmit` returns 0 errors.

**Commit 1a** — Delete dead code in `extension.ts`  
Remove lines 186-469 (dead `registerChatParticipant()`) and the unused imports at lines 12-23 that only served it. This eliminates 4 of 11 tsc errors.  
Verify: `tsc --noEmit` drops from 11 to 7 errors.

**Commit 1b** — Fix App.tsx callback references  
Determine whether `handleRemoveFromView` and `handlePendingPositionsApplied` are needed. If the JSX features they served were intentionally removed, delete the JSX references. If they were accidentally deleted, restore them from `git show main:src/components/App.tsx`.  
Verify: `tsc --noEmit` drops from 7 to 5 errors.

**Commit 1c** — Fix useAppState.ts type imports  
Either export `LoadingPhase` and `AppView` from `src/engine/types.ts` (if the hook is intended for use), or delete `useAppState.ts` entirely if it's scaffolding not yet consumed (App.tsx still has its own state).  
Verify: `tsc --noEmit` drops from 5 to 3 errors.

**Commit 1d** — Fix runTest.ts errors  
Address the 3 remaining tsc errors in `src/test/runTest.ts` (missing `fs` import, invalid `testRunnerPath` property).  
Verify: `tsc --noEmit` returns 0.

**Gate**: `tsc --noEmit` = 0, `npm run build` succeeds.

### Stage 2: Restore CT behavioral correctness (FINDING-001, 002, 003)

**Goal**: Column trace init() behaves identically to main.

**Commit 2a** — Restore `this.direction` and `this.targetColumns` assignments in `columnTraceState.ts` init(), plus restore the direction validation block.

This is not a "fix" — it is restoring accidentally deleted lines. The diff against `git show main:src/ai/columnTraceState.ts` should show exactly these lines were present and are now absent. Restore them in the same relative position within init().

**Verification** (mandatory):
1. `npm run test:internal` — the `column-trace-state.test.ts` must pass (this tests init/submit/getResult).
2. Manual verification: read the diff of `columnTraceState.ts` init() after fix against main. The only differences should be:
   - `initial_summary` parameter (additive — OK)
   - Memory delegation to `AiMemoryManager` (structural — OK)
   - Logging changes (cosmetic — OK)
   - Everything else identical to main.

**Gate**: `npm run test:internal` passes. Diff of init() reviewed line-by-line.

### Stage 3: Fix regex regression (FINDING-011)

**Goal**: `FROM_TERMINATOR_RE` produces the same regex as the original inline version.

**Commit 3a** — Fix `FROM_TERMINATOR_RE` construction in `shared/sqlRegex.ts`. The fix must ensure `\b` is only appended to word-character terminators, not to `;`, `\)`, or `$`.

**Verification** (mandatory):
1. Print both regex strings and compare:
   ```
   OLD: \s*(?:WHERE\b|JOIN\b|...|SET\b|;|\)|$)
   NEW: <must produce identical output>
   ```
2. `npm test` — the parser tests must pass (snapshot baseline).
3. Run `npx tsx test-internal/snapshot-deps.ts` against all 3 dacpacs and compare output to main's baseline. Zero regressions.

**Gate**: Parser snapshot baseline matches main.

### Stage 4: Intentional behavioral changes — review and document

These are not bugs — they are design decisions that should be explicitly acknowledged:

**FINDING-004** (budget rounds removed from system prompt): Decide whether this was intentional. If yes, document in commit message why. If not, restore the budget line. The `maxRounds` parameter is now dead code in `buildSystemPromptBase()` — either use it or remove it.

**FINDING-005** (LaTeX rendering rewrite): This is a deliberate improvement. Verify manually by running the extension, creating an AI view with math content, and checking rendering in the webview. Document the visual verification in the commit message.

**FINDING-006** (error limit mismatch): Fix the error message to reference the correct limit from `AiMemoryManager`, or accept the discrepancy and document why.

**FINDING-007** (graphAdjustments prompt block): This is an intentional feature addition. Document in CHANGELOG.

**FINDING-012** (DDL viewer empty detail): Decide whether opening an empty detail panel is the intended UX. If yes, document. If no, restore the no-op behavior.

**Gate**: Each decision documented in commit message. No ambiguity about intent.

### Stage 5: Full verification sweep

After all stages complete:

```bash
tsc --noEmit                    # 0 errors
npm test                         # all engine tests pass
npm run test:internal            # all AI/SM tests pass  
npm run build                    # extension builds clean
npx tsx test-internal/snapshot-deps.ts > tmp/after.tsv
diff tmp/baseline.tsv tmp/after.tsv   # 0 regressions
```

---

## 4. TEST STRATEGY RECOMMENDATION

### Immediate (this branch, before merge)

The deleted hook tests are out of scope for this branch — restoring them requires re-adding vitest as a dev dependency, which is a separate concern. However, the CT init regression proves that the test gap is dangerous.

**Minimum**: Ensure `test-internal/column-trace-state.test.ts` covers:
- Init with direction='down' — verify `getScopeDirection()` returns 'downstream'
- Init with direction='both' — verify 'bidirectional'
- Init with targetColumns=['Revenue'] — verify `this.targetColumns` is populated
- Init with invalid direction — verify error return

If these tests already exist, run them. If they don't, add them. These are the specific behaviors that regressed — they must have tests before merge.

### Short-term (next sprint)

**Option A (recommended)**: Restore the 5 Vitest hook test files from main. Re-add vitest as devDependency. Add `test:hooks` script to package.json. This recovers 1647 lines of proven test coverage with minimal effort.

**Option B**: Port the hook tests to the new Mocha+VS Code Test CLI infrastructure. More work, unified framework. Only choose this if there's a strong reason to eliminate vitest.

### Test-first rule going forward

Any refactoring that touches a function with existing tests must:
1. Run the tests before starting (baseline)
2. Run the tests after restructuring (verify equivalence)
3. Only delete tests after the refactored code passes them

This branch violated this rule — tests were deleted in the same branch as the refactoring, eliminating the safety net.

---

## 5. AI ENGINEERING PERSPECTIVE

### Memory manager extraction — correct approach

The `AiMemoryManager` encapsulation is well-designed. It preserves the two-tier semantics (detail = per-node evidence, short = narrative index) without changing limits or validation logic. The injection pattern (constructor param with default) allows both production use and test mocking.

### Session singleton — acceptable trade-off

`AiSession` via `getSession()` is a pragmatic choice for a VS Code extension where there's genuinely one AI session at a time. The `globalThis` singleton is standard for VS Code extension state. The public property exposure is acceptable given the extension's single-threaded nature — adding getters/setters would be ceremony without benefit.

### Prompt changes — need eval baseline

FINDING-004 (budget removal) and FINDING-007 (graphAdjustments) change what the AI model sees. These are prompt surface changes that fall under the project's "one change per iteration" policy (CLAUDE.md line 23). They should be:
1. Logged in `ai/prompt-changelog.md`
2. Baselined with an eval run (even informal) to confirm no regression in trace quality
3. Committed separately from the structural refactoring

Bundling prompt changes with a 58-file refactoring makes it impossible to isolate which change caused any AI behavior difference.

### `initial_summary` parameter — good addition

Pre-seeding memory with discovery context is a sound pattern. It reduces redundant re-exploration on follow-up messages. No risk.

### `forceComplete()` and `toJSON()` — overdue additions

Both should have existed earlier. `forceComplete()` handles the real edge case of sessions ending mid-trace. `toJSON()` enables debugging and eval infrastructure. No behavioral risk.

---

## 6. PROCESS RECOMMENDATIONS

### R1: Add `tsc --noEmit` to pre-commit hook

This branch has 11 compilation errors that would have been caught immediately. A pre-commit hook running `tsc --noEmit` prevents uncompilable code from being committed.

### R2: Never delete tests in the same branch as refactoring

The test files should have been kept on this branch and only deleted after the refactored code passed them. Deleting tests and restructuring code in the same commit eliminates the safety net exactly when it's most needed.

### R3: Verify regex extractions produce identical output

When consolidating inline regex into shared modules, add a comment with the expected output string:
```typescript
// Expected: \s*(?:WHERE\b|JOIN\b|...|SET\b|;|\)|$)
export const FROM_TERMINATOR_RE = new RegExp(...);
```
This makes regression visible in code review.

### R4: Separate prompt changes from structural refactoring

The project's CLAUDE.md correctly mandates "one change per iteration" for AI prompt surfaces. The budget removal and graphAdjustments addition should be separate commits with eval baselines, not bundled with the decomposition.

### R5: Run parser snapshot baseline after any engine/ change

Any change to `engine/` files should be followed by:
```bash
npx tsx test-internal/snapshot-deps.ts > tmp/after.tsv
diff tmp/baseline.tsv tmp/after.tsv
```
This catches subtle regex/parsing regressions like FINDING-011.

---

## 7. MERGE READINESS CRITERIA

The branch is ready to merge to `testing` when ALL of the following are true:

| # | Criterion | Verification |
|---|-----------|-------------|
| 1 | `tsc --noEmit` returns 0 errors | Run command |
| 2 | `npm test` passes all suites | Run command |
| 3 | `npm run test:internal` passes all suites | Run command |
| 4 | `npm run build` succeeds | Run command |
| 5 | Parser snapshot baseline matches main | diff baseline.tsv after.tsv |
| 6 | CT init with direction='down' works correctly | Test or manual trace |
| 7 | CT init with targetColumns=['X'] populates correctly | Test or manual trace |
| 8 | No dead code in extension.ts (lines 186-469 deleted) | grep |
| 9 | FROM_TERMINATOR_RE produces same regex as main | String comparison |
| 10 | Each intentional behavioral change documented in commit | git log review |

---

## 8. SUMMARY VERDICT

| Dimension | Assessment |
|-----------|-----------|
| **Architecture** | Strong improvement. SRP, DIP, coupling all better. Correct decomposition. |
| **Behavioral correctness** | **BLOCKED** by 2 data-loss regressions in CT init + 3 build breaks |
| **Test coverage** | **DEGRADED** — 2043 lines net loss. CT regression proves the gap is dangerous. |
| **AI prompt integrity** | 2 prompt changes bundled with refactoring — should be separate commits |
| **Parser correctness** | **REGRESSED** — FROM_TERMINATOR_RE regex bug |
| **Code quality** | Net positive. 6 `as any` casts and 11 `z.any()` are tech debt, not blockers. |
| **Merge readiness** | **NO-GO** until Stages 1-3 complete and all 10 criteria met |

The refactoring is architecturally sound and the majority of the extraction is correct. The problems are concentrated in a few specific locations (CT init, App.tsx, sqlRegex.ts) and are all fixable. Once the 5 CRITICAL and 3 MEDIUM findings are resolved, this branch represents a clear improvement over main.
