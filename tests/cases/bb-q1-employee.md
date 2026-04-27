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
- [HumanResources].[uspUpdateEmployeePersonalInfo]

## Forbidden Nodes
- Forbidden utility nodes (uspLogError, uspPrintError, ErrorLog) in scope at d≥2 but MUST be pruned via verdict=prune.

## Expected Structural Coverage (DDL-derived)

> The AI can only emit a structural element if the DDL contains the upstream evidence. This table lists what the DDL of each Required Node actually contains and the corresponding output element a complete capture would produce. Missing where DDL has nothing to show is **not a failure**; missing where DDL has the evidence **is**.

| Required node | DDL evidence available | Expected long-memory element |
|---|---|---|
| `[HumanResources].[Employee]` (table, 16 cols, no body) | column list only | column-group naming; no formulas/joins to extract |
| `[HumanResources].[vEmployee]` (view, 1,262 chars, 5 INNER JOINs across address chain) | 4 column-AS renames (`pnt.[Name] AS [PhoneNumberType]`, `sp.[Name] AS [StateProvinceName]`, `cr.[Name] AS [CountryRegionName]`, `e.[JobTitle]`); 5 INNER JOINs through `Person` → `BusinessEntityAddress` → `Address` → `StateProvince` → `CountryRegion` | 1 markdown table mapping the renames; ⚠️ for INNER-JOIN address-chain drop semantics (employee with no address row is dropped) |
| `[HumanResources].[vEmployeeDepartment]` (view, 613 chars, current-employee filter) | 2 column renames (`d.[Name] AS [Department]`, etc.); `WHERE edh.EndDate IS NULL` business filter; `EmployeeDepartmentHistory` point-in-time semantics | column-rename mini-table; code-fenced `WHERE edh.EndDate IS NULL` quote; ⚠️ for "shows only current departments" behaviour |
| `[HumanResources].[uspUpdateEmployeeHireInfo]` (procedure, 1,120 chars) | UPDATE Employee (3 cols: JobTitle, HireDate, CurrentFlag) + INSERT EmployeePayHistory (4 cols) inside `BEGIN TRANSACTION + BEGIN TRY/CATCH`; `uspLogError` handler | code-fenced UPDATE statement; code-fenced INSERT statement; loading-pattern label `append` (history table) + `upsert` (Employee row); ⚠️ for transactional-rollback behaviour |
| `[HumanResources].[uspUpdateEmployeeLogin]` (procedure, 687 chars) | UPDATE Employee (5 cols: OrganizationNode, LoginID, JobTitle, HireDate, CurrentFlag) + BEGIN TRY/CATCH + `uspLogError` handler | code-fenced UPDATE statement; loading-pattern label `upsert`; named writer columns |
| `[HumanResources].[uspUpdateEmployeePersonalInfo]` (procedure, 628 chars) | UPDATE Employee (4 cols: NationalIDNumber, BirthDate, MaritalStatus, Gender) + BEGIN TRY/CATCH + `uspLogError` handler | code-fenced UPDATE statement; loading-pattern label `upsert`; named PII columns (⚠️ if PII-handling is in scope) |

**Expected coverage where DDL has the evidence (no char floors):**

The rubric does NOT impose lower-bound character counts on long memory or `result_graph.description`. A structurally thin DDL produces a thin section honestly; inventing length to hit a target is a correctness failure. The check is binary per element — *"DDL contains the evidence ⇒ output should reflect it"*:

| DDL evidence in this case | Output element a complete capture should produce |
|---|---|
| 2 views with column-AS renames (vEmployee, vEmployeeDepartment) | ≥ 2 markdown column-rename tables across the persisted body |
| 3 writer SPs with explicit UPDATE statements | ≥ 3 code-fenced SQL evidence blocks (one per writer) |
| 1 WHERE filter (`edh.EndDate IS NULL` in vEmployeeDepartment) | ≥ 1 code-fenced WHERE-clause quote |
| 2 INNER-JOIN drop semantics (vEmployee address chain + vEmployeeDepartment current-only) | ≥ 2 ⚠️ callouts |
| Question demands two sections labelled "Writers" / "Readers" | exactly 2 `present_result.sections[]` with those labels |

Chat narration should be brief — terse wrap-up only; no per-node deep dive (that belongs in `result_graph.description`).

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
