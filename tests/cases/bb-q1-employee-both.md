# bb-q1-employee-both

## Question

> Build a bidirectional annotated lineage graph around [HumanResources].[Employee] with traversal depth 2. Document both the business meaning of each node AND the technical execution (loading patterns, join strategies, SQL evidence). Annotate every node with a one-sentence caption describing its role. Prune any error-handling or utility-only objects as prune. Classification: both business and technical.

## Classification

| Field | Value |
|-------|-------|
| Type | bb |
| Subtype | Multi-branch sliding |
| Persona | Data Engineer + Business Analyst |
| Difficulty | hard |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | [HumanResources].[Employee] |
| Direction | bidirectional |
| Columns | _None_ |
| Filter | _None_ |
| Mission classification | both |

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
| Max total runtime (ms) | 60000 |

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
3. `lineage_start_exploration` with origin="[HumanResources].[Employee]", direction="bidirectional", depth=2, **classification="both"**.
4. The tool returns `error: 'action_required', gate: 'confirm_sm_start'`. Gate detail must show "Analysis: business + technical driven".
5. Post `POST /gate` with `{ approved: true }`.
6. Loop through hops:
   - Each `submit_findings` call (verdict=analyze or pass) submits `sections: [{ angle: 'business', text: '<WHAT>' }, { angle: 'technical', text: '<HOW>' }]` — exactly TWO sections, one per angle.
   - Submitting only one section MUST be rejected with `classification_lock_violation`.
   - Submitting two business sections (or two technical) MUST be rejected.
7. Agenda drains → synthesis prompt.
8. Call `lineage_present_result` with sections[] containing TWO peer entries per relevant node (one business-flavored, one technical-flavored) — NOT nested with `#### Technical` subheading.
   - The AI MAY consolidate sibling business sections into one comparison-table entry (and same for technical) — that's the across-node grouping decision at synthesis.
9. Return chat answer covering both angles.

## Verification Rules
- `start_exploration.input.classification === 'both'`.
- Every analyze/pass `submit_findings.input.sections[]` has length 2 with one `angle === 'business'` AND one `angle === 'technical'`.
- `present_result.sections[]` contains entries that lift business and technical content as PEER entries (no `#### Technical` nested subheadings inside section text).
- `badge_label` diversity > 0.3.
- Chat answer mentions both business meaning and technical execution.

## Evaluation Notes
- Tests the classification-locked sections contract (G11) under the `both` value — the most demanding path.
- Confirms BOTH `business_capture` and `technical_capture` YAML templates fire at active phase.
- Confirms BOTH `business_subsection` and `technical_subsection` synthesis templates fire — and emit as PEER sections, not nested.
- Cross-cuts the synthesis grouping rule (sibling-variant comparison tables stay per-angle).
