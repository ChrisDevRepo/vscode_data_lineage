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

### FINDING-008 — Dead code: extension.ts:186-469
- **Feature**: F-059 (registerChatParticipant)
- **File**: `src/extension.ts`
- **Verdict**: ❌ MISSING (dead code — function exists but never called)
- **Severity**: HIGH (maintenance risk, not runtime)
- **Evidence**: grep confirms zero callers. References undefined `extractToolCallFields`.
- **UAT Risk**: NO (never executed) — but confuses maintainers

