# doc-q1-readme

## Question

> Summarize the Sales schema — what's in it, how do the main objects relate? I need this for onboarding documentation.

## Classification

| Field | Value |
|-------|-------|
| Type | documentation |
| Subtype | Schema overview — PM / tech writer |
| Persona | PM |
| Difficulty | medium |
| Dacpac | tests/fixtures/AdventureWorks2025_AI.dacpac |
| Origin | _None — schema-wide_ |
| Direction | _n/a or bidirectional_ |
| Columns | _None_ |
| Filter | schemas: [Sales] |

## Expected Outcome

| Field | Value |
|-------|-------|
| SM Type | none OR bb (either valid) |
| Delivery | classic OR inline |
| Memory mode | n/a or Inline |
| Scope | 0–15 |
| Max hops | 0 or inline batch |
| Filter expected | Yes (Sales) |
| Required tools | lineage_get_context, lineage_search_objects |
| Forbidden tools | _None_ |
| Max total runtime (ms) | 120000 |
| Max hop-avg tokens | 4000 |

## Fact Check (verified 2026-04-16)

- Filter [Sales] limits to Sales schema (26 objects: 19 tables, 7 views)
- Either classic tool approach (`get_context` + `search_objects`) OR BB exploration works — scorer accepts both paths
- Expected nodes if SM path chosen: vSalesPerson, SalesPerson, SalesOrderHeader

## Required Response Content

Response must cover:
- Sales schema scope (tables, views, procedures)
- Main tables (SalesOrderHeader, SalesPerson, etc.)
- Views (vSalesPerson, vSalesPersonSalesByFiscalYears)
- Key relationships

## Required Nodes

_None required — structured response is OK. If SM used, vSalesPerson + SalesPerson + SalesOrderHeader should appear._

## Forbidden Nodes

_None._

## Optimal Path

**Option A (classic, faster):**
1. get_context → schema stats
2. search_objects with schemas=[Sales] → object list
3. Write structured markdown response

**Option B (with SM for richer output):**
1. set filter = [Sales]
2. start_exploration from a hub table (e.g. SalesOrderHeader) bidirectional
3. Small scope (due to filter) → inline
4. enrich_view with sections per object category

## Known Limitations

_Either option valid. Tests breadth of approaches to documentation queries — no strict SM requirement._
