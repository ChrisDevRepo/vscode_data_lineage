# bb-q1-employee-technical

## Question

> Build a bidirectional annotated lineage graph around [HumanResources].[Employee] with traversal depth 2. Focus on technical execution: loading patterns, join strategies, SQL evidence per node. Annotate every node with a one-sentence caption describing its role in this flow. Prune any error-handling or utility-only objects as prune. Classification: technical only.

## Classification

| Field | Value |
|-------|-------|
| Type | bb |
| Subtype | Multi-branch sliding |
| Persona | DBA |
| Difficulty | medium |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | [HumanResources].[Employee] |
| Direction | bidirectional |
| Columns | _None_ |
| Filter | _None_ |
| Mission classification | technical |

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
3. `lineage_start_exploration` with origin="[HumanResources].[Employee]", direction="bidirectional", depth=2, **classification="technical"**.
4. The tool returns `error: 'action_required', gate: 'confirm_sm_start'`. Gate detail must show "Analysis: technical-driven".
5. Post `POST /gate` with `{ approved: true }`.
6. Loop through hops:
   - Each `submit_findings` call submits `sections: [{ angle: 'technical', text: '<HOW body>' }]` — exactly ONE section, angle=technical.
   - Submitting `angle: 'business'` MUST be rejected with `classification_lock_violation`.
7. Agenda drains → synthesis prompt.
8. Call `lineage_present_result` with sections[] grouping technical content (loading patterns, join strategies).
9. Return chat answer summarizing the technical view.

## Verification Rules
- `start_exploration.input.classification === 'technical'`.
- Every `submit_findings.input.sections[]` has length 1 with `angle === 'technical'` (verdict=prune may have length 0).
- No section with `angle === 'business'` is accepted (would trigger classification_lock_violation).
- `present_result.sections[]` content is technical-angle (SQL evidence, loading patterns, no business-meaning prose).
- `badge_label` diversity > 0.3.

## Evaluation Notes
- Tests the classification-locked sections contract (G11) under the `technical` value.
- Confirms only `technical_capture` YAML template fires (templateRenderer CLASSIFICATION_GATED).
- Confirms `business_subsection` does NOT fire at synthesis.
