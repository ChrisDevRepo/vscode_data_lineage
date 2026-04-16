# bb-inline-q2-vemployee-filtered

## Question

> What does vEmployee aggregate?

## Classification

| Field | Value |
|-------|-------|
| Type | bb (Blackboard) |
| Subtype | Filter as starting point — forces small scope |
| Persona | any |
| Difficulty | easy |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | [HumanResources].[vEmployee] |
| Direction | upstream |
| Columns | _None_ |
| Filter | schemas: [HumanResources] |

## Expected Outcome

| Field | Value |
|-------|-------|
| SM Type | bb |
| Delivery | inline |
| Memory mode | Inline (no sliding memory) — scope ≤ 10 |
| Scope | 3–10 nodes |
| Max hops | 1 (inline batch) |
| Filter expected | Yes (HumanResources) |
| Required tools | lineage_start_exploration, lineage_enrich_view |
| Forbidden tools | _None_ |
| Max total runtime (ms) | 60000 |
| Max hop-avg tokens | 5000 |
| Max rejections | 2 |
| Max rejection rate | 30% |

## Fact Check (verified 2026-04-16)

- Origin: [humanresources].[vemployee] ✓
- Filter: [HumanResources] only (NOT [HumanResources, Person] — latter gives scope=13, sliding)
- **scope: 5** → inline ✓ (scope ≤ 10)
- Expected in-scope nodes: Employee, EmployeePayHistory, EmployeeDepartmentHistory, uspUpdateEmployee* SPs (~5 HR-only neighbors)

## Required Nodes

- Employee
- Person

## Forbidden Nodes

- uspLogError

## Optimal Path

1. Set filter = [HumanResources, Person] before exploration
2. start_exploration upstream of vEmployee — cross-schema filter limits scope to ~5-8 nodes
3. Inline delivery (scope ≤ 10)
4. enrich_view documenting the employee/person composition

## Known Limitations

_None._
