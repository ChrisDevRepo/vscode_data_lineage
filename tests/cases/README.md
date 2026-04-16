# Test Cases

Each case is a markdown file following a fixed structure. The `scorer.ts` parses these files and compares agent behavior against the `Expected Outcome` table.

## Success criteria — read `EVAL-RUBRIC.md` before authoring new tests

Grading is **output-quality-first**, not process-metric-first. A run with rich `enrich_view` content + correct nodes + type-appropriate detail beats a run with fewer hops or fewer errors.

Rubric dimensions (0-3 each, 12 total):
1. **Correctness** — right nodes with right verdicts
2. **Completeness** — scope drained, structure present
3. **Question-Answering** — the enrich_view actually answers the user's question
4. **Type-Appropriate Detail** — category-matched content (formulas for business, column tables for CT, hints for perf, etc.)

**Memory-quality pre-gate:** if `detail_analysis` averages < 400 chars/node, or `narrative_update` averages < 150 chars/hop, the enrich_view score is capped at 6/12 because the memory is too thin to produce rich output.

Full rubric + mechanical checks + terminology convention: `EVAL-RUBRIC.md`.

## File naming

`{category}-{sequence}-{slug}.md`

| Category | Meaning |
|----------|---------|
| `disc-` | Discovery / metadata query (no SM expected) |
| `perf-` | Performance / analysis (no SM expected) |
| `expl-` | Explanation / SQL reading (no SM expected) |
| `doc-` | Documentation request (SM or classic tools) |
| `bb-` | BlackboardState exploration with sliding memory |
| `bb-inline-` | BlackboardState with inline delivery (small scope) |
| `ct-` | Column trace with sliding memory |
| `ct-inline-` | Column trace with inline delivery |
| `dep-` | Dependency trace (CT without columns) — sliding |
| `dep-inline-` | Dependency trace — inline |
| `follow-` | Multi-turn follow-up on a completed SM result |

## File structure

```markdown
# {test-id}

## Question

> User question the AI sees

## Classification

| Field | Value |
|-------|-------|
| Type | bb / ct / discovery / analysis / explanation / documentation / multi-turn |
| Subtype | optional — e.g. "Dependency Trace (Type 2, no columns)" |
| Persona | any / junior-dev / PM / DBA |
| Difficulty | easy / medium / hard |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | [schema].[object] or `_AI must discover_` |
| Direction | up / down / both / upstream / downstream / bidirectional / ai-decides |
| Columns | [col1, col2] or `_None_` |
| Filter | None / schemas: [...] / types: [...] |

## Expected Outcome

| Field | Value |
|-------|-------|
| SM Type | bb / ct_columns / ct_deps / none |
| Delivery | sm / inline / classic (no SM) |
| Memory mode | Two-tier (sliding) / Inline (no sliding) / n/a |
| Scope | N–M nodes |
| Max hops | N |
| Filter expected | Yes / No |
| Required tools | [tool names] or _any_ |
| Forbidden tools | [tool names] or _None_ |
| Max total runtime (ms) | N |
| Max hop-avg tokens | N |
| Max rejections | N (0 = no errors allowed) |
| Max rejection rate | N% (rejections / tool calls) |

## Required Nodes

Required nodes that MUST appear in the final result (detail_memory or enrich_view nodes).

- [schema].[name]

## Forbidden Nodes

Nodes that MUST NOT appear (utility, errors, irrelevant).

- uspLogError

## Multi-turn Follow-up (if applicable)

### Turn 2

> "User message for turn 2"

Expected behavior: call enrich_view with `add_ids` or `prune_node_ids`, etc.

## Optimal Path

Numbered steps an ideal AI would take.

## Known Limitations

_None._ or description of the limitation.
```

## Metadata fields for scoring

Each case's `Expected Outcome` table drives the scorer:

- **SM Type**: checks `sess.stateMachine.constructor.name` (or "none" if no SM)
- **Delivery**: checks `sess.stateMachine.inlineMode` (inline=true → "inline", false → "sm")
- **Memory mode**: derived from `inlineMode` (inline=no sliding)
- **Scope**: checks `sess.stateMachine.scopeSize` within [min, max]
- **Max hops**: checks `sess.stateMachine.hopCount <= max`
- **Filter expected**: checks `sess.filter.schemas.length > 0`
- **Required tools**: checks `hopLog` contains these tool names
- **Forbidden tools**: checks `hopLog` does NOT contain these
- **Max total runtime (ms)**: wall-clock start → done
- **Max hop-avg tokens**: Σ(hop input+output chars) / hopCount / 4
- **Max rejections**: count of `hopLog[].output.error` entries
- **Max rejection rate**: rejections / total tool calls (%)

### Rejection categories

Tracked from `hopLog[].output.error`:

| Error type | Meaning |
|------------|---------|
| `focus_mismatch` | Agent sent wrong `focus_node_id` for current hop |
| `invalid_verdict` | Verdict not in allowed set (relevant/pass/irrelevant) |
| `orphan_rejection` | Prune would orphan a noted node (smGuards.wouldOrphanNotedNode) |
| `cascade_rejection` | Prune cascade would remove >50% of agenda |
| `invalid_node_id` | Node ID not in model (focus, prune, add) |
| `validation_error` | Input failed schema validation |
| `unknown_tool` | Tool name not registered |
| `active_sm` | Second SM start attempt while first is active (TTL/completion check) |
| `tool_error_other` | Any other error surfaced by the tool |

The MD report shows rejections grouped by type, with recovery status (did the next call succeed?).

## Adding a new case

1. Copy an existing file in the same category
2. Update `id` in filename + `# {id}` heading
3. Fill in `Classification` + `Expected Outcome` tables
4. Add `Required Nodes` / `Forbidden Nodes`
5. Write `Optimal Path`
6. Run `npm run test:eval` (uses this file to score results)

## Current suite: 21 tests (fact-checked 2026-04-16)

**Correctness priority:** Every case's `Fact Check` section documents ground-truth measurements (scope size, delivery mode, required/forbidden nodes) verified against the real `AdventureWorks2025_AI.dacpac` via the tool proxy. The `Expected Outcome` table is the authoritative spec — the scorer enforces it.

| Category | Count | Tests | Scope |
|----------|-------|-------|-------|
| Discovery / no-SM | 5 | disc-q1-schemas, disc-q2-tables, perf-q1-hubs, expl-q1-sql, doc-q1-readme | 0 (no SM) |
| BB inline (≤10) | 3 | bb-inline-q1-vproduct (5), bb-inline-q2-vemployee-filtered (5), bb-inline-q3-errorlog (5) | 5-8 |
| BB sliding (>10) | 3 | bb-q1-employee (46), bb-q4-sales (varies), bb-q10-ai-report-sources (20) | 12-50 |
| CT columns inline | 2 | ct-inline-q2-jobtitle-filtered (4), ct-q3-businessentityid (4) | 4 |
| CT columns sliding | 2 | ct-q1-totalrevenue (26), ct-q2-customersegment (20) | 20-26 |
| CT deps inline | 1 | dep-inline-q1-vemployeedepartment (8) | 8 |
| CT deps sliding | 2 | dep-q1-vemployee (13), dep-q2-vsalesperson-sliding (15) | 13-15 |
| Multi-turn follow-up | 3 | follow-q1-add-cross-schema, follow-q2-prune-scope, follow-q3-active-sm-warning | varies |

### Delivery mode coverage (verified by fact-check)

- **5 classic** (no SM) — prevents overfitting
- **6 inline** (scope ≤ 10) — batch delivery tested
- **7 sliding** (scope > 10) — hop-by-hop memory tested
- **3 multi-turn** — session persistence, prune, re-enrich

### Filter usage

- **No filter** (13 tests) — full model navigation
- **Starting-point filter** (8 tests) — filter defines scope before SM: disc-q2, doc-q1, bb-inline-q1/q2, ct-inline-q2, dep-inline-q1, dep-q2, follow-q1
