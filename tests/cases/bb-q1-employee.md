# bb-q1-employee

## Question

> Build a bidirectional annotated lineage graph around [HumanResources].[Employee] with traversal depth 2. Organize the result into two sections titled exactly 'Writers' and 'Readers': Writers = procedures that modify Employee rows, Readers = views/functions that consume Employee columns. Annotate every node with a one-sentence caption describing its role in this flow. Prune any error-handling or utility-only objects as irrelevant.

## Classification

| Field | Value |
|-------|-------|
| Type | bb (Blackboard) |
| Subtype | Medium-scope sliding |
| Persona | any |
| Difficulty | medium |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | [HumanResources].[Employee] |
| Direction | bidirectional |
| Columns | _None_ |
| Filter | schemas: [HumanResources, Sales] |

## Expected Outcome

| Field | Value |
|-------|-------|
| SM Type | bb |
| Delivery | sm (hop-by-hop) |
| Memory mode | Two-tier (hop-by-hop with sliding memory) — scope > 10 |
| Scope | 15–35 nodes |
| Max hops | 12 |
| Filter expected | Yes (HumanResources + Sales) |
| Required tools | lineage_start_exploration, lineage_submit_findings, lineage_enrich_view |
| Forbidden tools | _None_ |
| Max total runtime (ms) | 180000 |
| Max hop-avg tokens | 3500 |
| Max rejections | 3 |
| Max rejection rate | 20% |

## Fact Check (verified 2026-04-16 against AdventureWorks2025_AI)

- Origin: [humanresources].[employee] ✓
- With filter [HumanResources, Sales] and depth=2, **scope ≈ 25 nodes** (full d=5 is 46 — we intentionally narrow for short runtime).
- Required writer SPs: uspUpdateEmployeeHireInfo, uspUpdateEmployeeLogin, uspUpdateEmployeePersonalInfo — all in HumanResources.
- Required reader views: vEmployee, vEmployeeDepartment, vEmployeeDepartmentHistory (HR) + vSalesPerson, vSalesPersonSalesByFiscalYears (Sales).
- Forbidden utility nodes (uspLogError, uspPrintError, ErrorLog) in scope at d≥2 but MUST be pruned via verdict=irrelevant.

## Required Nodes

Writers (must be under the "Writers" section):
- uspUpdateEmployeeHireInfo
- uspUpdateEmployeeLogin
- uspUpdateEmployeePersonalInfo

Readers (must be under the "Readers" section):
- vEmployee
- vEmployeeDepartment
- vEmployeeDepartmentHistory
- vSalesPerson
- vSalesPersonSalesByFiscalYears
- ufnGetContactInformation

## Forbidden Nodes (must be pruned as `irrelevant`)

- uspLogError
- uspPrintError
- ErrorLog

## Optimal Path

1. Apply schema filter [HumanResources, Sales].
2. `lineage_search_objects` query="Employee" schemas=["HumanResources"] → resolve origin id.
3. `lineage_start_exploration` origin=[HumanResources].[Employee], direction="bidirectional", depth=2.
4. Scope > 10 → hop-by-hop sliding memory.
5. Per-hop `lineage_submit_findings`:
   - Writers (procs): verdict=relevant, badge_label="Writer", note_caption describes which columns the proc updates.
   - Readers (views): verdict=relevant, badge_label="Reader", note_caption describes which columns the view exposes.
   - uspLogError / uspPrintError / ErrorLog: verdict=irrelevant → cascade-prune.
6. Continuation-contract: keep calling submit_findings until agenda empty.
7. `lineage_enrich_view` with 2 sections ("Writers", "Readers"), notes[] for every kept node, summary ≤300 chars.

## Deliverable shape

- enrich_view.sections[] length = 2, labels exactly "Writers" and "Readers".
- notes[] count ≥ 8 (one per non-origin non-pruned node).
- At least 3 verdict=irrelevant submissions for the error-handling objects.
- No "Writer"/"Reader" terminology in section labels outside the named two sections (they are the exact labels).

## Why this question is focused

- "annotated lineage graph" → `enrich_view`, not prose.
- "bidirectional" → direction=bidirectional, no inference.
- "depth 2" → fixes scope size; prevents the AI picking depth=1 (too thin) or depth=5 (too expensive).
- "two sections titled exactly 'Writers' and 'Readers'" → unambiguous section structure.
- "Prune any error-handling or utility-only objects as irrelevant" → explicit irrelevant-verdict cue.
- "Annotate every node with a one-sentence caption" → forces note_caption coverage.

## Known Limitations

_None._
