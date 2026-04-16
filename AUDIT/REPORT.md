# POST-REFACTORING AUDIT REPORT

Generated: 2026-04-16
Branch old: `main` | Branch new: `refactor/inspection-findings-2026`

---

## EXECUTIVE SUMMARY

| Metric | Value |
|--------|-------|
| Files audited | 58 (including 6 deleted) |
| Features inventoried (old extension.ts) | 130 |
| Features inventoried (state machines) | 172 |
| Features verified EQUIVALENT or IDENTICAL | 89 + ~155 = ~244 |
| Features REFACTORED (same logic, new structure) | 40 + ~13 = ~53 |
| Features CHANGED (behavior differs) | 11 |
| Features MISSING (not found in new) | 3 (2 critical CT init, 1 direction validation) |
| UNVERIFIABLE (need runtime test) | 2 (math rendering, AI pacing) |
| TypeScript compilation errors | **11** |
| Findings total | **14** |
| CRITICAL | **5** |
| HIGH | **1** |
| MEDIUM | **3** |
| LOW | **5** |
| Cross-file contract breaks | 1 (FROM_TERMINATOR_RE) |

**UAT GO/NO-GO: NO-GO**

The branch has 5 CRITICAL findings including 2 data-loss regressions in the column trace state machine and 3 build-breaking TypeScript errors. The extension **cannot compile** in its current state. These must be fixed and verified before UAT.

---

## CRITICAL — MUST FIX BEFORE UAT

| ID | File | Description | UAT Impact |
|---|---|---|---|
| FINDING-001 | `columnTraceState.ts` | `this.direction` never assigned in `init()` — all downstream/bidirectional CT traces silently default to upstream | All non-upstream column traces produce wrong results |
| FINDING-002 | `columnTraceState.ts` | `this.targetColumns` never assigned in `init()` — column data lost | All column traces lose their target columns |
| FINDING-009 | `App.tsx:1260,1266` | `handleRemoveFromView` and `handlePendingPositionsApplied` deleted but still referenced | Build break — `TS2304` |
| FINDING-010 | `useAppState.ts:4` | Imports `LoadingPhase`/`AppView` from types that don't exist | Build break — `TS2305` |
| FINDING-014 | Multiple files | 11 total `tsc --noEmit` errors | Extension cannot compile |

### Required Fixes

**Fix 1** — `src/ai/columnTraceState.ts` init() (after line 189):
```typescript
const { targetColumns: rawCols, origin, direction = 'up', initial_summary } = params;
// ADD these two lines:
this.direction = direction;
this.targetColumns = [...new Set((rawCols ?? []).map((c: string) => c.trim()).filter(Boolean))];
```

**Fix 2** — `src/ai/columnTraceState.ts` init() — restore direction validation:
```typescript
if (!['up', 'down', 'both'].includes(direction)) {
  this._status = 'error';
  return { error: 'invalid_direction', hint: `Direction must be 'up', 'down', or 'both'.` };
}
```

**Fix 3** — `src/components/App.tsx` — either restore deleted callbacks or remove JSX references at lines 1260 and 1266.

**Fix 4** — `src/hooks/useAppState.ts` — either export `LoadingPhase`/`AppView` from `types.ts` or remove the import.

**Fix 5** — `src/extension.ts:186-469` — delete dead `registerChatParticipant()` and its unused imports (lines 12-23). This eliminates 4 of the 11 tsc errors.

---

## HIGH — SHOULD FIX BEFORE UAT

| ID | File | Description | UAT Impact |
|---|---|---|---|
| FINDING-008 | `extension.ts:186-469` | 284 lines dead code (never-called function, references undefined `extractToolCallFields`) | Maintenance confusion, 4 tsc errors |

---

## MEDIUM — FIX BEFORE PRODUCTION

| ID | File | Description | UAT Impact |
|---|---|---|---|
| FINDING-003 | `columnTraceState.ts` | Direction validation removed (masked by FINDING-001) | Bad direction values silently accepted |
| FINDING-004 | `prompts.ts` | Budget rounds removed from system prompt | AI pacing may change for long explorations |
| FINDING-011 | `shared/sqlRegex.ts:55` | `FROM_TERMINATOR_RE` adds `\b` after `;`, `\)`, `$` — old code did not | ANSI comma-join may fail to terminate at `;`/`)` |

### FROM_TERMINATOR_RE Fix:
```typescript
// OLD (correct):
(?=\s*(?:WHERE\b|JOIN\b|...|SET\b|;|\)|$))

// NEW (broken):
FROM_TERMINATORS.join('\\b|')  // adds \b after ALL items including ; \) $

// FIX: Only add \b to word-character terminators
const wordTerminators = FROM_TERMINATORS.filter(t => /^\w/.test(t));
const nonWordTerminators = FROM_TERMINATORS.filter(t => !/^\w/.test(t));
export const FROM_TERMINATOR_RE = new RegExp(
  `\\s*(?:${wordTerminators.map(t => t + '\\b').join('|')}|${nonWordTerminators.join('|')})`, 'i'
);
```

---

## LOW — COSMETIC / INFORMATIONAL

| ID | File | Description |
|---|---|---|
| FINDING-005 | `tools.ts` | LaTeX math rendering rewritten (regex→state machine). May affect edge cases. |
| FINDING-006 | `blackboardState.ts`, `columnTraceState.ts` | Error limit constant mismatch (says 500, actual 1200) |
| FINDING-007 | `smPrompts.ts` | graphAdjustments block added to all SM prompts |
| FINDING-012 | `App.tsx` | DDL viewer opens empty detail panel (was no-op) |
| FINDING-013 | `NodeInfoBar.tsx` | Hover delay added (150ms open, 100ms close) |

---

## UNVERIFIABLE — RUNTIME TESTING REQUIRED

| Feature | File | Test Needed | Priority |
|---------|------|-------------|----------|
| Math rendering pipeline | `tools.ts`, `AiDescriptionOverlay.tsx` | Render AI description with LaTeX formulas (cases, aligned, inline math) in webview | HIGH |
| AI pacing without budget hint | `prompts.ts` | Run multi-hop CT/BB trace and compare round counts with/without budget line | MEDIUM |

---

## ENGINEERING QUALITY VERDICT

| File | Delta | Evidence |
|------|-------|---------|
| `extension.ts` | IMPROVED | 3477→469 lines, SRP achieved, but 284 dead lines remain |
| `panelProvider.ts` | IMPROVED | Clean extraction with BridgeHost abstraction |
| `commands.ts` | IMPROVED | Pure command registration, dependency injection |
| `ai/lineageParticipant.ts` | IMPROVED | Class encapsulation, DI params. 6 `as any` casts to fix. |
| `ai/toolProvider.ts` | IMPROVED | Clean tool dispatch, helper functions extracted |
| `ai/session.ts` | IMPROVED | Explicit singleton vs scattered globals |
| `ai/memoryManager.ts` | IMPROVED | Encapsulated memory with clear API |
| `ai/smBase.ts` | IMPROVED | Memory delegation, toJSON, forceComplete |
| `ai/blackboardState.ts` | NEUTRAL | Minor logging changes + initial_summary |
| `ai/columnTraceState.ts` | **REGRESSED** | 2 CRITICAL missing assignments in init() |
| `ai/smPrompts.ts` | IMPROVED | New synthesis prompt, graphAdjustments |
| `ai/prompts.ts` | NEUTRAL | New builders, but budget removal is debatable |
| `ai/tools.ts` | IMPROVED | Better LaTeX handling, incremental enrich_view |
| `engine/shared/*` | IMPROVED | DRY consolidation, BUT regex bug in FROM_TERMINATOR_RE |
| `components/App.tsx` | **REGRESSED** | 2 build errors from deleted callbacks |
| `hooks/useAppState.ts` | **REGRESSED** | Build errors from non-existent type imports |
| `components/NodeInfoBar.tsx` | IMPROVED | Proper JS-positioned tooltips |
| `utils/log.ts` | IMPROVED | OOP Logger + test capture |

**Overall: POSITIVE (with blockers)**

The architectural decomposition is a significant improvement to maintainability, testability, and separation of concerns. However, the refactoring introduced 5 CRITICAL issues that prevent the branch from compiling or functioning correctly. Once fixed, the net quality is strongly positive.

---

## TEST COVERAGE ASSESSMENT

| Category | Before (main) | After (refactor) | Net |
|----------|--------------|-------------------|-----|
| Hook unit tests (Vitest) | 1647 lines | 0 | -1647 |
| VS Code integration tests | 0 | 433 lines | +433 |
| Test infrastructure | 829 lines | 0 | -829 |
| **Total** | **2476** | **433** | **-2043** |

**Unguarded behaviors** (previously tested, now not):
1. `useDacpacLoader` routing — 14 state transition tests
2. `useGraphology` filter pipeline — 9 suites
3. `useInteractiveTrace` path-finding — 9 suites
4. `useOverviewMode` auto-trigger — 5 suites
5. `save-project` serialization flow

**Recommendation**: Restore hook tests (Option A: re-add vitest as devDependency + `test:hooks` script).

---

## WHAT THIS AUDIT CANNOT GUARANTEE

1. **Runtime behavior of math rendering** — LaTeX pipeline was rewritten; needs visual verification in webview
2. **AI pacing impact** — budget line removal from system prompt; needs live multi-hop trace comparison
3. **Floating UI tooltip edge cases** — viewport boundary behavior, touch devices, high-contrast mode
4. **IPC message contract completeness** — bridgeContract.ts Zod schemas not yet consumed by runtime validation
5. **Hook state machine correctness** — no unit tests for filter pipeline, trace calculation, overview mode

---

## AUDIT INTEGRITY LOG

- Total files in manifest: 58
- Files fully processed: ~45 (all source code files)
- Files skipped: package-lock.json (auto-generated), README.md/CHANGELOG.md/docs (documentation-only)
- Git commits made: 4 (bootstrap, batch 1, batch 3, batch 4+5)
- Agent runs: 6 (2 for Batch 1, 2 for Batch 3, 1 for Batch 4+5, plus initial exploration)
- All CRITICAL findings verified with second-pass (grep, tsc --noEmit, file reads)
- Agent claim corrections: 2 (inlineMode was on interface; `as any` count was 6 not 13)
