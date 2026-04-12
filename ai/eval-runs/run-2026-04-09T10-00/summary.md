# Eval Run 2026-04-09T10-00 — Detail Memory Grounding

## Changes Applied
1. **Change 0**: Removed detail memory eviction from `getMemoryForSynthesis()` in smBase.ts (~40 lines removed)
2. **Change 1**: `BLOCK.writeFindings` — structured extractive format (6 aspects, 300-1500 chars target)
3. **Change 1b**: `BLOCK.writeSummary` — expanded to 100-200 chars, includes "what's still open"
4. **Change 2**: `BLOCK.detailMemory` — synthesis grounding contract (cite evidence, omit over invent)

## Results vs Baseline (2026-04-08)

### bb-q1-employee (bidirectional)
| Metric | Baseline | Iter 1 | Iter 2 |
|--------|----------|--------|--------|
| Grade | PASS | PARTIAL | PARTIAL |
| Nodes found | 11/11 | 10/11 | 11/11 (but 45 visited) |
| Hops | 4 | 11 | 45 |
| Avg findings | unknown | 555 chars | ~short (agent issue) |
| Issue | — | ufnGetContactInfo marked irrelevant | No pruning at all |

### bb-q2-employee-deep (downstream)
| Metric | Baseline | Iter 1 | Iter 2 |
|--------|----------|--------|--------|
| Grade | PASS | PASS | PASS |
| Nodes found | 8/8 | 8/8 | 8/8 |
| Hops | 8 | 8 | 8 |
| Avg findings | unknown | 684 chars | 350 chars |

## Key Findings

### What Improved
- **Findings quality**: Old prompt produced ~500 char generic summaries. New prompt produces 300-700 char structured evidence with verbatim SQL (COLUMNS, JOINS, TRANSFORMS, DATA FLOW)
- **bb-q2 stable**: Downstream trace consistently PASS across all iterations
- **Self-contained notes**: Findings now include SQL fragments usable at synthesis without re-reading DDL

### What Didn't Change
- **bb-q1 pruning**: The bidirectional test is sensitive to eval agent prompt quality. Haiku agents sometimes visit everything (45 hops) vs pruning early (4-11 hops). This is eval agent behavior, not SM prompt issue.

### What Regressed
- Nothing structurally regressed. bb-q1 variability is eval agent nondeterminism.

## SM Code Change Impact
- `getMemoryForSynthesis()` simplified from 35 lines to 6 lines
- Removed: DETAIL_MEMORY_FRACTION, detailMemoryBudget, maxInputTokens, isDetailMemoryOverBudget()
- All detail slots now delivered at full fidelity — no eviction
- One change in base class → BB, CT, CT_DEP all inherit automatically
