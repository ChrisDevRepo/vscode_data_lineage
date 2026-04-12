# Eval Comparison: Question-Adaptive Evidence Prompts

## Date: 2026-04-12
## Model: Sonnet (claude-sonnet-4-6)
## Branch: fix/question-adaptive-prompts

## CT Business Logic — "Trace AdjustedRevenue upstream"

| Metric | Baseline | After v1 | After v2 (SQL restored) |
|---|---|---|---|
| Hops | 14 | 18 | TBD (manual test) |
| Avg analysis length | 916 chars | 480 chars | TBD |
| SQL evidence % | 63% | 35% | TBD |
| Business meaning % | 58% | 83% | TBD |
| Both SQL+biz % | 42% | 30% | TBD |

**v1 issue:** Removing "Quote SQL verbatim" caused shorter analysis. v2 restored it.

## BB Performance — "What are performance risks?" (new prompts only)

| Metric | Value |
|---|---|
| Hops | 19 |
| Avg analysis length | 701 chars |
| Performance notes % | 74% |
| SQL evidence % | 53% |
| Business meaning % | 89% |

**Validates question adaptation:** Performance question → performance-focused findings stored in memory.

## Haiku vs Sonnet

| Dimension | Haiku | Sonnet | Verdict |
|---|---|---|---|
| Avg findings length | 300-700 | 480-916 | Sonnet 2x deeper |
| Column rename tracking | Frequent errors | Clean | Sonnet far better |
| Prune decisions | Inconsistent | Consistent | Sonnet better |
| Business meaning | Rare | 58-83% | Sonnet much better |
| Hallucination rate | High | Low | Sonnet much better |
| Token usage | ~30-50K | ~100-130K | Sonnet 2-3x more expensive |

**Conclusion:** Sonnet justified as eval model — Haiku too terse for evidence quality testing.

## Changes Applied

1. `writeFindings` — WHAT/HOW depth adaptation + restored SQL verbatim grounding
2. `detailMemory` — "transfer, don't re-summarize" synthesis contract
3. `sections.instruction` — multi-label CLASSIFY with WHAT/HOW content contracts
4. `sections` example — richer multishot example with SQL + business meaning
5. Internal docs updated (dataflow.md, ai.md, AI_PROMPTS.md)
6. Eval model default → Sonnet
