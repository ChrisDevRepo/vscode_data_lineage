# bb-q1-employee

## Question

> Build a bidirectional annotated lineage graph around [HumanResources].[Employee] with traversal depth 2. Organize the result into two sections titled exactly 'Writers' and 'Readers': Writers = procedures that modify Employee rows, Readers = views/functions that consume Employee columns. Annotate every node with a one-sentence caption describing its role in this flow. Prune any error-handling or utility-only objects as prune.

## Classification

| Field | Value |
|-------|-------|
| Type | bb |
| Subtype | Multi-branch sliding |
| Persona | PM |
| Difficulty | medium |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | [HumanResources].[Employee] |
| Direction | bidirectional |
| Columns | _None_ |
| Filter | _None_ |

## Expected Outcome

| Field | Value |
|-------|-------|
| SM Type | bb |
| Delivery | sm (sliding) |
| Memory mode | Two-tier (sliding) |
| Scope | 30–35 nodes |
| Max hops | 15 |
| Required tools | lineage_start_exploration, lineage_submit_findings, lineage_present_result |
| Forbidden tools | _None_ |
| Max total runtime (ms) | 45000 |

## Required Nodes
- [HumanResources].[Employee]
- [HumanResources].[vEmployee]
- [HumanResources].[vEmployeeDepartment]
- [HumanResources].[uspUpdateEmployeeHireInfo]
- [HumanResources].[uspUpdateEmployeeLogin]
- [HumanResources].[uspUpdateEmployeePersonalStatus]

## Forbidden Nodes
- Forbidden utility nodes (uspLogError, uspPrintError, ErrorLog) in scope at d≥2 but MUST be pruned via verdict=prune.

## Optimal Path
1. `lineage_get_context` to verify schemas.
2. `lineage_search_objects` for [HumanResources].[Employee].
3. `lineage_start_exploration` with origin="[HumanResources].[Employee]", direction="bidirectional", depth=2.
4. The tool returns `error: 'action_required', gate: 'confirm_sm_start'`.
5. Post `POST /gate` with `{ approved: true }`.
6. Fresh turn: AI receives the first hop context (origin).
7. Loop through hops (12–15 nodes):
   - Employee (origin): verdict=analyze, badge_label="Anchor".
   - Writers (procs): verdict=analyze, badge_label="Writer", note_caption describes which columns the proc updates.
   - Readers (views): verdict=analyze, badge_label="Reader", note_caption describes which columns the view exposes.
   - uspLogError / uspPrintError / ErrorLog: verdict=prune → cascade-prune.
8. Agenda drains → synthesis prompt.
9. Call `lineage_present_result` with 2 sections ("Writers", "Readers"), notes[] for every kept node, summary ≤300 chars.
10. Return chat answer with a 3-paragraph business summary.

## Known Limitations
_None._

## Verification Rules
- `present_result.name` exists.
- `present_result.sections[]` length = 2, labels exactly "Writers" and "Readers".
- At least 3 `verdict=prune` submissions for the error-handling objects.
- `badge_label` diversity > 0.3.
- Chat answer mentions at least one Reader view and one Writer proc.

## Evaluation Notes
- "annotated lineage graph" → `present_result`, not prose.
- "two sections titled exactly 'Writers' and 'Readers'" → strict section-label constraint.
- "Prune any error-handling or utility-only objects as prune" → explicit prune-verdict cue.
