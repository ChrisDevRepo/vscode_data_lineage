# bb-dep-q1-vemployee

## Question

> Trace all dependencies upstream from vEmployee

## Classification

| Field | Value |
|-------|-------|
| Type | bb — Dependency-style chain walk |
| Subtype | Unfiltered sliding |
| Persona | any |
| Difficulty | easy |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | [HumanResources].[vEmployee] |
| Direction | up |
| Columns | _None_ |
| Filter | None |

## Expected Outcome

| Field | Value |
|-------|-------|
| SM Type | bb |
| Delivery | sm |
| Memory mode | Two-tier (hop-by-hop with sliding memory) |
| Scope | 10–20 nodes |
| Max hops | 12 |
| Filter expected | No |
| Required tools | lineage_start_exploration, lineage_submit_findings, lineage_enrich_view |
| Forbidden tools | _None_ |
| Max total runtime (ms) | 180000 |
| Max hop-avg tokens | 3500 |
| Max rejections | 3 |
| Max rejection rate | 25% |

## Fact Check (verified 2026-04-16)

- Origin: [humanresources].[vemployee] ✓
- **scope: 13 nodes** → sliding ✓ (scope > 10)
- Delivery: sliding (confirmed — no scope_nodes in response)
- vEmployee reads from Employee + Person + 11 other HR/Person/Address tables

## Required Nodes

- Employee (direct dep)
- Person (direct dep)

## Forbidden Nodes

_None._

## Optimal Path

1. Search for vEmployee → [HumanResources].[vEmployee]
2. start_exploration direction=up, depth=5 (no targetColumns → BB mode)
3. Scope=13 → sliding mode. Agent hops:
   - Hop 1: Employee (relevant — direct source)
   - Hop 2: Person (relevant — cross-schema)
   - Hops 3+: address / phone / email tables (pass or relevant)
4. enrich_view with dependency list

## Known Limitations

_FK-only edges (no SQL body reference) are not in the graph._
