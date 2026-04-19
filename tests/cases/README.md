# Test Cases — Baseline-v1

Four cases drive the current baseline. See `EVAL-RUBRIC.md` for scoring and `.claude/skills/eval-loop/SKILL.md` for orchestration.

Archived cases live in `tmp/cases-archive/` and are out of scope until UAT parity is proven.

## Baseline suite

| Case | Mode | Memory | Exercises `confirm_sm_start` gate |
|---|---|---|---|
| `bb-inline-q1-vproduct.md` | blackboard | inline | no |
| `bb-q1-employee.md` | blackboard | sliding | yes |
| `ct-inline-q1-jobtitle.md` | column_trace | inline | no |
| `ct-q1-totalrevenue.md` | column_trace | sliding | yes |

The pair `(inline, sliding)` is present for each mode so each run covers both delivery paths and the gate.

## File structure (authoritative for new/updated cases)

```markdown
# {test-id}

## Question

> One user-facing question the AI sees.

## Classification

| Field | Value |
|-------|-------|
| Type | bb / ct |
| Subtype | optional qualifier (e.g. "Small-scope inline", "Multi-branch sliding") |
| Persona | any / junior-dev / PM / DBA |
| Difficulty | easy / medium / hard |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | [schema].[object] |
| Direction | upstream / downstream / bidirectional |
| Columns | [col1, col2] or _None_ |
| Filter | schemas: [...] or _None_ |

## Expected Outcome

| Field | Value |
|-------|-------|
| SM Type | bb / ct_columns |
| Delivery | sm (sliding) / inline |
| Memory mode | Two-tier (sliding) / Inline |
| Scope | N–M nodes |
| Max hops | N |
| Required tools | lineage_start_exploration, lineage_submit_findings, lineage_enrich_view |
| Forbidden tools | _None_ or list |
| Max total runtime (ms) | N |

## Required Nodes
- [schema].[name]

## Forbidden Nodes
_None._ or list

## Optimal Path
1. Numbered steps an ideal AI would take.

## Known Limitations
_None._ or short description.
```

## Tool surface today (10 tools)

- Stateless: `lineage_get_context`, `lineage_search_objects`, `lineage_get_object_detail`, `lineage_run_bfs_trace`, `lineage_run_analysis`, `lineage_search_ddl`, `lineage_get_ddl_batch`
- Stateful SM: `lineage_start_exploration` (optional `targetColumns` → column_trace), `lineage_submit_findings`, `lineage_enrich_view`

No separate `start_column_trace` / `submit_batch_*` / `expand_frontier` — the unified `NavigationEngine` handles both modes behind one tool pair.

## Gate mechanism

When scope > 10 and ≤ safe-max (17 in the bridge, 35 in production), `lineage_start_exploration` returns:

```json
{
  "error": "action_required",
  "gate": "confirm_sm_start",
  "classes": ["sliding_memory"],
  "detail": "Large task — N nodes to analyze, budget ~M hops.\n...",
  "hop_context": { ... }
}
```

In real chat, the user replies "yes"/"no". In the eval bridge, the agent posts to `/gate` with `{approved: true|false}` — same transport shape as `POST /tool`.

## Adding a new case

1. Copy the closest existing case.
2. Rename the file and the `# {test-id}` heading.
3. Fill in `Classification` + `Expected Outcome` + `Required Nodes`.
4. Verify ground truth against the fixture (`tests/fixtures/AdventureWorks2025_AI.dacpac`) by querying via the bridge.
5. Run `python tests/eval/run.py <test-id> <run-id>` and inspect the generated prompt + extracted report.
