# Custom DMV queries

A live-database import reads the catalog with the queries in [`assets/dmvQueries.yaml`](../assets/dmvQueries.yaml). This page lists what runs and what a custom file must return.

## Setup

1. Run **Data Lineage: Create DMV Queries** from the Command Palette. It copies the built-in YAML to `dmvQueries.yaml` in the first workspace folder; an existing file is opened, not overwritten.
2. Set `dataLineageViz.dmvQueriesFile` to `dmvQueries.yaml` in VS Code Settings.
3. Edit the SQL, for example to add `WHERE` filters. The file is read again at every import.

The connection needs `VIEW DEFINITION` for lineage and `SELECT` on tables for table statistics. Supported: SQL Server 2016 or later, Azure SQL, Fabric Data Warehouse, Synapse Dedicated SQL Pool.

## Query execution

An import runs:

| Step | Queries | When |
|---|---|---|
| Phase 1 | `schema-preview` | First, to fill the schema-selection wizard. |
| Platform detection | `platform-info` | After the preview, and again at the start of Phase 2 (10-second limit). If missing, failing or empty, the platform is `Unknown database platform`. |
| Object catalog | `all-objects` | Once, unfiltered, so references into unselected schemas are recognized. |
| Phase 2 | `nodes`, `columns`, `constraints`, `dependencies` | After schema selection, with `{{SCHEMAS}}` expanded. |

`{{SCHEMAS}}` expands to the selected schemas, for example `N'dbo', N'Sales'`. Keep it in every Phase 2 query; without it the query ignores the selection and a warning is logged. Profiling SQL is not configurable here; see [`PROFILING_PATTERNS.md`](PROFILING_PATTERNS.md).

## YAML structure

```yaml
version: 1
queries:
  - name: schema-preview
    phase: 1
    sql: |
      SELECT ...
  - name: nodes
    phase: 2
    sql: |
      SELECT ... WHERE s.name IN ({{SCHEMAS}})
```

| Field | Notes |
|---|---|
| `version` | Must match the shipped file. After an upgrade, rename your copy, re-run **Create DMV Queries** and re-apply your edits. |
| `name`, `sql` | Required per query; an entry without them is skipped. |
| `phase` | `1` or `2`; default `2`. Keep `platform-info` at `phase: 1`. |

Required queries: `schema-preview`, `nodes`, `columns`, `dependencies`. Optional: `all-objects`, `constraints`, `platform-info` (without it, table statistics report an error).

## Expected columns

Column names match case-insensitively; extra columns are ignored. Only `platform-info` is checked, so a wrong shape elsewhere can leave the model empty or incomplete.

| Query | Columns |
|---|---|
| `schema-preview` | `schema_name`, `type_code`, `object_count` |
| `all-objects` | `schema_name`, `object_name`, `type_code` |
| `nodes` | `schema_name`, `object_name`, `type_code`, `body_script` (DDL; NULL for tables) |
| `platform-info` | `engine_edition`, `major_version`, `edition`; optional `identifier_collation`, `identifier_comparison_style` (decide identifier case sensitivity) |
| `columns` | `schema_name`, `table_name`, `column_name`, `type_name`, `max_length` (-1 = max), `precision`, `scale`, `is_nullable`, `is_identity`, `is_computed`; optional `pk_ordinal` (drives PK badges) |
| `constraints` | `schema_name`, `table_name`, `constraint_type` (`FK`, `UQ`, `CK`), `constraint_name`, `column_name`; FK only: `ref_schema`, `ref_table`, `ref_column`, `on_delete` |
| `dependencies` | `referencing_schema`, `referencing_name`, `referenced_schema`, `referenced_name`; optional `referenced_database`, `referenced_server`, `referencing_column`, `referenced_column`, `referenced_type` |

`type_code` uses `sys.objects.type` codes (`U`, `V`, `P`, `FN`, `IF`, `TF`), plus `ET` for external tables. `referencing_column` and `referenced_column` let a column trace bind a scalar function to the column that calls it; without `referenced_database` and `referenced_server`, cross-database references are not recognized. Columns appear in result row order, so keep the `ORDER BY`.

## Example: exclude a schema

Add the same predicate to every query that returns objects; one query alone leaves the schema reachable.

| Query | Restricted predicate |
|---|---|
| `schema-preview`, `all-objects` | `s.name NOT IN ('sys','INFORMATION_SCHEMA', N'Audit')` |
| `nodes`, `columns`, `constraints` | `s.name IN ({{SCHEMAS}}) AND s.name NOT IN (N'Audit')` |
| `dependencies` | add `AND s1.name NOT IN (N'Audit') AND d.referenced_schema_name NOT IN (N'Audit')` |

## Errors and fallback

| Situation | Result |
|---|---|
| No file configured | Built-in queries. |
| File missing, unreadable, invalid YAML or no usable query | Built-in queries and a warning. |
| `version` missing or different | Built-in queries and a warning naming both versions. |
| A required query is missing | A warning lists it; the import fails at that step. |

## Check it works

Open **View → Output → Data Lineage Viz**, set the log level to **Debug**, and run an import. Each query logs as `[DB] Executing <name> (step/total)` with the first 300 characters of SQL.

Dynamic SQL is not captured by `sys.sql_expression_dependencies`, and only the connected database is read.
