# AUDIT FINDINGS

Behavioral differences between main and refactor/inspection-findings-2026.
Verdicts: EQUIVALENT / CHANGED / MISSING / DEGRADED / UNVERIFIABLE

---

## Batch 3: State Machine Files

### FINDING-001 — CRITICAL REGRESSION: `this.direction` never assigned in CT init()
- **Feature**: F-286 (ColumnTraceState.init)
- **File**: `src/ai/columnTraceState.ts`
- **Old lines**: main:194 (`this.direction = direction;`)
- **New lines**: MISSING — destructured at line 189 but never assigned to `this.direction`
- **Verdict**: ❌ MISSING
- **Severity**: CRITICAL
- **Evidence**: `private direction: ColumnTraceDirection = 'up'` at line 74 stays at default. `getScopeDirection()` at line 161 reads `this.direction`. All downstream/bidirectional CT traces silently execute as upstream.
- **UAT Risk**: YES — any downstream or bidirectional column trace produces wrong results
- **Validated**: YES (grep confirmed zero `this.direction =` assignments in file)

### FINDING-002 — CRITICAL REGRESSION: `this.targetColumns` never assigned in CT init()
- **Feature**: F-286 (ColumnTraceState.init)
- **File**: `src/ai/columnTraceState.ts`
- **Old lines**: main:~192 (`this.targetColumns = [...new Set((rawCols ?? []).map(...))]`)
- **New lines**: MISSING — destructured `rawCols` at line 189 but never assigned to `this.targetColumns`
- **Verdict**: ❌ MISSING
- **Severity**: CRITICAL
- **Evidence**: `private targetColumns: string[] = []` at line 75 stays at default. Line 201 reads `this.targetColumns.length` which is always 0. Auto-discover always runs, column data lost.
- **UAT Risk**: YES — all column traces lose their target column data
- **Validated**: YES (grep confirmed zero `this.targetColumns =` assignments in file)

### FINDING-003 — Direction validation removed in CT init()
- **Feature**: F-286 (ColumnTraceState.init)
- **File**: `src/ai/columnTraceState.ts`
- **Old lines**: main:~186-191 (validates direction ∈ ['up','down','both'])
- **New lines**: MISSING
- **Verdict**: 🔶 DEGRADED
- **Severity**: MEDIUM (masked by FINDING-001; if that's fixed, this becomes HIGH)
- **Evidence**: No validation block in init(). Invalid directions silently accepted.
- **UAT Risk**: YES (after FINDING-001 fix) — bad direction values cause unpredictable behavior

### FINDING-004 — Budget rounds removed from system prompt
- **Feature**: F-335 (buildSystemPromptBase)
- **File**: `src/ai/prompts.ts`
- **Old lines**: main:~14 (`Budget: ${maxRounds} rounds.`)
- **New lines**: Removed
- **Verdict**: ⚠️ CHANGED
- **Severity**: MEDIUM
- **Evidence**: `maxRounds` parameter still accepted but unused. AI no longer sees round limit.
- **UAT Risk**: POSSIBLE — AI pacing may change for long explorations

### FINDING-005 — LaTeX math handling completely rewritten
- **Feature**: F-360 (autoFixEnrichView) + new `fixLatex()` in tools.ts
- **File**: `src/ai/tools.ts`
- **Verdict**: ⚠️ CHANGED
- **Severity**: MEDIUM
- **Evidence**: Old regex-based `$$` wrapping replaced by line-by-line state machine converting to ```math code fences. Different rendering pipeline.
- **UAT Risk**: POSSIBLE — math content will render differently. May fix existing bugs but could introduce new edge cases.

### FINDING-006 — Error limit constant mismatch in BB/CT submissions
- **Feature**: F-256, F-290
- **File**: `src/ai/blackboardState.ts`, `src/ai/columnTraceState.ts`
- **Verdict**: ⚠️ CHANGED
- **Severity**: LOW
- **Evidence**: Error message says `limit: this.summaryHardLimit` (500) but actual rejection at `AiMemoryManager.addNarrative()` uses 1200 hard limit. Cosmetic only.
- **UAT Risk**: NO (AI may over-compress narratives but no functional break)

### FINDING-007 — graphAdjustments prompt block added to all SM modes
- **Feature**: F-332, F-333, F-334
- **File**: `src/ai/smPrompts.ts`
- **Verdict**: ⚠️ CHANGED
- **Severity**: LOW
- **Evidence**: New `BLOCK.graphAdjustments` appended to BB, CT, CT_DEP prompts. Instructs AI on add_ids/prune_ids for graph modifications.
- **UAT Risk**: LOW — AI may attempt new operations it didn't before

## Batch 4+5: Engine + Components

### FINDING-009 — BUILD ERROR: Missing callbacks in App.tsx
- **File**: `src/components/App.tsx` lines 1260, 1266
- **Verdict**: ❌ MISSING
- **Severity**: CRITICAL (blocks compilation)
- **Evidence**: `handleRemoveFromView` and `handlePendingPositionsApplied` deleted but still referenced in JSX. `tsc --noEmit` confirms `TS2304`.
- **UAT Risk**: YES — extension will not compile
- **Validated**: YES (tsc confirms)

### FINDING-010 — BUILD ERROR: Missing type exports in useAppState.ts
- **File**: `src/hooks/useAppState.ts` line 4
- **Verdict**: ❌ MISSING
- **Severity**: CRITICAL (blocks compilation)
- **Evidence**: Imports `LoadingPhase` and `AppView` from `../engine/types` but these types don't exist. `tsc --noEmit` confirms `TS2305`.
- **UAT Risk**: YES — extension will not compile
- **Validated**: YES (tsc confirms)

### FINDING-011 — REGEX BUG: FROM_TERMINATOR_RE adds \b after non-word tokens
- **File**: `src/engine/shared/sqlRegex.ts` line 55
- **Old**: `(?=\\s*(?:WHERE\\b|JOIN\\b|...|SET\\b|;|\\)|$))` — no `\b` after `;`, `\)`, `$`
- **New**: `FROM_TERMINATORS.join('\\b|')` → `WHERE\b|...|SET\b|;\b|\)\b|$\b` — `\b` after all tokens
- **Verdict**: ⚠️ CHANGED (regression)
- **Severity**: MEDIUM
- **Evidence**: `\b` is a word boundary; `;` and `)` are non-word chars. `;\b` matches `;\w` but NOT `; ` (whitespace). Old code correctly matched `;` followed by whitespace. `$\b` is always false.
- **UAT Risk**: YES — ANSI comma-join normalization in sqlBodyParser may fail to terminate at `;` or `)`, producing incorrect rewrites
- **Validated**: YES (compared old regex in main:sqlBodyParser.ts vs new regex)

### FINDING-012 — DDL viewer opens empty detail panel when no node selected
- **File**: `src/components/App.tsx` ~line 1270
- **Old**: No-op when no node highlighted
- **New**: Opens detail panel without a node
- **Verdict**: ⚠️ CHANGED
- **Severity**: LOW
- **Evidence**: `postMessage({ type: 'show-detail' })` + `setIsDetailOpen(true)` without node data
- **UAT Risk**: LOW — additive behavior

### FINDING-013 — NodeInfoBar hover delay changed
- **File**: `src/components/NodeInfoBar.tsx`
- **Old**: Instant CSS hover
- **New**: Floating UI with 150ms open / 100ms close delay
- **Verdict**: ⚠️ CHANGED
- **Severity**: LOW
- **Evidence**: `useHover({ delay: { open: 150, close: 100 } })`
- **UAT Risk**: LOW — UX polish, not functional

### FINDING-014 — 11 TypeScript compilation errors total
- **Files**: App.tsx (2), extension.ts (4), useAppState.ts (2), runTest.ts (3)
- **Severity**: CRITICAL (extension cannot build)
- **Evidence**: `npx tsc --noEmit` returns 11 errors
- **Validated**: YES

### FINDING-008 — FIXED: Dead code removed (extension.ts:186-469)
- **Status**: RESOLVED in commit 00d34c3

## Batch 6: Test Coverage Gap

### FINDING-015 — 101 hook unit tests deleted, 8 integration tests added (net -93)
- **Severity**: HIGH (regression safety net removed)
- **Evidence**: 5 vitest hook test files deleted (1647 lines, 101 assertions). Replaced by 8 VS Code integration tests (433 lines). Net loss: 93 tests.
- **Highest-risk gaps**:
  - `useGraphology` filter pipeline (25 tests) — core rendering path
  - `useInteractiveTrace` state machine (27 tests) — trace modes, pathfinding
  - `useDacpacLoader` routing (30 tests) — message routing, known past regression guard
  - `useOverviewMode` auto-trigger (16 tests) — threshold logic
  - `save-project` RC1 regression guard (3 tests) — filePath serialization bug
- **UAT Risk**: HIGH — subtle state machine bugs now unguarded

### FINDING-016 — `npm test` silently drops vitest hook tests from CI gate
- **File**: `package.json` scripts.test
- **Severity**: MEDIUM
- **Evidence**: vitest run was removed from `npm test` chain, but vitest is still a dependency and copilot-instructions.md still claims `npm test` runs vitest.
- **UAT Risk**: Tests exist but never run — false sense of coverage

## Batch 7: Config + Docs

### FINDING-017 — start_exploration modelDescription truncated 73% (2327→620 chars)
- **File**: `package.json` (contributes.languageModelTools)
- **Severity**: HIGH (AI prompt surface — violates "one change per iteration" rule)
- **Evidence**: Removed: scope_direction guidance, expand_frontier workflow, working memory explanation, prune_ids/add_ids docs, agenda workflow, question guidance. Only core usage and schemas[] param remain.
- **UAT Risk**: HIGH — AI may misuse scope_direction (causing scope_too_broad errors), not understand prune_ids/add_ids, or fail to use expand_frontier correctly.
- **Validated**: YES (char count confirmed: 2327→620)

### FINDING-018 — start_column_trace modelDescription removes INPUT columns guidance
- **File**: `package.json` (contributes.languageModelTools)
- **Severity**: MEDIUM (AI prompt surface)
- **Evidence**: Paragraph about "columns must be INPUT columns appearing in the origin" removed.
- **UAT Risk**: MEDIUM — AI may specify output columns instead of input columns, causing validation failures.

### FINDING-019 — esbuild minification unconditionally disabled
- **File**: `esbuild.config.mjs`
- **Old**: `minify: !watch` (minify in production, skip in dev)
- **New**: `minify: false` (never minify)
- **Severity**: MEDIUM (bundle size regression for marketplace release)
- **Evidence**: git diff confirms single-line change
- **UAT Risk**: NO (functional), but VSIX will be larger than necessary

### FINDING-020 — CHANGELOG history deleted
- **File**: `CHANGELOG.md`
- **Severity**: MEDIUM
- **Evidence**: All entries before 0.9.9 replaced. Version history from 0.5.0-0.9.8 lost from the file.
- **UAT Risk**: NO (cosmetic), but public users lose change visibility

### FINDING-021 — Stale cross-references in copilot-instructions.md
- **File**: `.github/copilot-instructions.md`
- **Severity**: LOW
- **Evidence**: `test:coverage` script referenced but removed; `test:ai:detail` doesn't exist; `npm test` described as including vitest but it doesn't.

### FINDING-022 — New runtime dependency: zod ^4.3.6
- **File**: `package.json` dependencies
- **Severity**: LOW (zod is well-maintained, MIT licensed)
- **Evidence**: Used by `src/engine/shared/bridgeContract.ts` for IPC schema validation.
- **UAT Risk**: LOW — adds ~50KB to bundle

## Phase 2-B: Cross-File Dependency Check

All 10 caller↔callee contract checks: **PASS**
No parameter mismatches, no broken import chains, no wrong return types.
One code quality note: `lineageParticipant.ts` uses `as any` to access `inlineMode` which is already on the `IHopStateMachine` interface — unnecessary cast.

