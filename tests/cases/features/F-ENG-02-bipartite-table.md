# F-ENG-02-bipartite-table

## Question

> Trace bidirectional lineage of `[HumanResources].[Employee]` (a table) depth 2.

## Classification

| Field | Value |
|-------|-------|
| Type | bb |
| Subtype | Engine → bipartite agenda (table origin) |
| Persona | analyst |
| Difficulty | easy |
| Origin | [HumanResources].[Employee] (table — non-bodied) |

## Expected Outcome

| Field | Value |
|-------|-------|
| `Employee` table is the FIRST hop on the agenda | yes (priority 3 — origin gets its own slot) |
| Subsequent hops | bodied neighbors only (views / procs / functions); no other tables on the agenda |
| Tables in scope but NOT on agenda | reachable via `lineage_get_neighbor_columns`, but never a hop target |
| `structural_summary` template fires for the origin (non-bodied) | yes |
| `business_capture` / `technical_capture` fires for bodied hops | yes |

## Required Nodes

- [HumanResources].[Employee] (origin — gets a hop)
- ≥3 bodied neighbors (views / procs)

## Forbidden Hop Targets

- Any non-origin table — should be in scope but never hop-targeted.

## Optimal Path

1. start_exploration → gate → approve.
2. Hop 1: focus = origin table → `structural_summary` template fires (per `CLAUDE.md`: "Reduced active-phase template for non-bodied origin nodes").
3. Hops 2+: bodied neighbors only. Engine bipartite agenda enforces this.
4. Synthesis lifts structural-summary slot for origin + business/technical slots for bodied nodes.

## Verification Rules

- `archive.detail_slots[0].nodeId` === origin table id.
- `archive.detail_slots[0].sections[0]` was captured via `structural_summary` (template name visible in capture metadata if logged, else verified via body-content shape).
- All non-origin slots are bodied (view / proc / function / view-function); no other tables.
- `[AI] [Hop N]` log lines: only one hop with type=table; rest are bodied types.

## Engine guards exercised

- Bipartite agenda (per `CLAUDE.md`: "Only bodied nodes ... enter the agenda as hop targets. Tables remain in scope (routable, inspectable). Exception: starting-point table (priority 3) gets its own agenda slot").
- `structural_summary` template firing for non-bodied origin.

## Harness

Standard. Already exercised in `bb-q1-employee` baseline.

## Evaluation Notes

Validates the engine's core agenda contract: tables are SCOPE (data) but not WORK (hops). Misclassifying tables as hop targets would explode hop budget without producing useful captures.
