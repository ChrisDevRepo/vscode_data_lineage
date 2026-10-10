# Custom DMV Queries

Live-database ingestion uses Dynamic Management View (DMV) queries defined in [`assets/dmvQueries.yaml`](../assets/dmvQueries.yaml). You can inspect the built-in SQL and override it in your workspace.

## Setup

1. Open the **Command Palette** (`Ctrl+Shift+P`) and run **Data Lineage: Create DMV Queries** — copies the built-in YAML into your workspace as `dmvQueries.yaml`.
2. Set `dataLineageViz.dmvQueriesFile` to `dmvQueries.yaml` in VS Code Settings (`Ctrl+,`, search "dataLineageViz").
3. Edit the SQL — add WHERE filters, adjust JOINs, swap a query for a vendor variant.
4. The YAML is loaded on every DB import. Table statistics on a built-in connection reuse the queries last loaded, until the next import or a change of `dataLineageViz.dmvQueriesFile`, so an invalid file warns once rather than on every request. Missing or unreadable files, invalid YAML, or a file with no usable query entries falls back to the built-in queries with a warning. Invalid individual entries are skipped; a partially valid custom file remains active.

## Prerequisites

- A connection available through `dataLineageViz.database.connectionProvider`: an MSSQL extension (`ms-mssql.mssql`) profile (default), or a built-in connection saved with **Data Lineage: Add Database Connection**.
- Permissions: `VIEW DEFINITION` on the database for lineage; `SELECT` on tables for profiling. Custom queries may need additional permissions.
- Supported platforms: SQL Server 2016+, Azure SQL, Fabric Data Warehouse, Synapse Dedicated SQL Pool.

## Query execution

Every executed DMV query is logged to the **Data Lineage Viz** Output channel with the `[DB]` category. To see what hit your database:

1. `View → Output → Data Lineage Viz`.
2. Set the channel log level to **Debug** (gear icon → Set Log Level → Debug). Phase milestones are at INFO; the per-query SQL is at DEBUG.
3. Open the wizard and run an import.
4. Each query is logged on execution as `[DB] Executing <name> (step/total) — SQL: <first 300 chars>`.

The 300-character cap is intentional for log hygiene. For the full built-in
SQL, read [`assets/dmvQueries.yaml`](../assets/dmvQueries.yaml). Custom SQL is
executed as configured; non-phase-1 queries receive `{{SCHEMAS}}` expansion.

Nothing runs automatically in the background. The standard import path uses:

| Phase | Queries | When |
|-------|---------|------|
| Phase 1 | `schema-preview` | Runs first to populate the schema-selection wizard. |
| Platform detection | `platform-info` | Runs once before the selected-schema model is built. If it is missing, fails, or returns no row, the extension uses authoritative MSSQL server metadata; if neither source is available, the model records `Unknown database platform` without failing the import. A built-in connection has no other source, so it records `Unknown database platform` directly instead of sending the query again. |
| Built-in connection | `platform-info` | A built-in connection reads server details (edition, version) with `platform-info`; it sends no SQL that is not in this file. The database name is typed, not listed. |
| Object catalog | `all-objects` | Runs once before the Phase 2 sweep (unfiltered). Lists every object across all schemas (no DDL, no columns) so references into unselected schemas classify as "cross-schema known" with correct schema casing instead of "unresolved". If it is missing or fails, those references stay unclassified; the import continues. |
| Phase 2 | `nodes`, `columns`, `constraints`, `dependencies` | Runs after schema selection. Each configured non-phase-1 query is executed with `{{SCHEMAS}}` expanded. |

The current live import executes `constraints` but does not pass those rows to
the extractor, so they do not enrich the table design view.

The built-in Phase 2 queries use `{{SCHEMAS}}`, which the extension expands to
the comma-separated, single-quoted schema list before execution (for example
`'dbo', 'Sales'`). The SQL author controls where the filter is applied; TypeScript
does not otherwise rewrite custom SQL.

## YAML structure

```yaml
version: 1
required_permission: "VIEW DEFINITION"
queries:
  - name: schema-preview   # Phase 1 — schema counts for the selection wizard
    phase: 1
    description: "..."
    sql: |
      SELECT ...
  - name: all-objects      # Phase 1 — full object catalog (no DDL), optional
    phase: 1
    description: "..."
    sql: |
      SELECT ...
  - name: platform-info    # Platform detection before model construction
    phase: 1
    description: "..."
    sql: |
      SELECT ...
  - name: nodes            # Phase 2 — DDL for selected schemas
    phase: 2
    description: "..."
    sql: |
      SELECT ... WHERE s.name IN ({{SCHEMAS}})
  - name: columns          # Phase 2 — column metadata
    phase: 2
    description: "..."
    sql: |
      SELECT ... WHERE s.name IN ({{SCHEMAS}})
  - name: constraints      # Phase 2 — FK, UQ, CK metadata (optional)
    phase: 2
    description: "..."
    sql: |
      SELECT ... WHERE s.name IN ({{SCHEMAS}})
  - name: dependencies     # Phase 2 — object-level references
    phase: 2
    description: "..."
    sql: |
      SELECT ... WHERE s1.name IN ({{SCHEMAS}}) OR d.referenced_schema_name IN ({{SCHEMAS}})
```

### Example: keep a schema out of the model

To hide a schema from the wizard and the graph, add the same predicate to every
query that returns objects. A restriction in only one query leaves the schema
reachable through the others.

| Query | Built-in predicate | Restricted |
|---|---|---|
| `schema-preview`, `all-objects` | `s.name NOT IN ('sys','INFORMATION_SCHEMA')` | `s.name NOT IN ('sys','INFORMATION_SCHEMA', N'Audit')` |
| `nodes`, `columns`, `constraints` | `s.name IN ({{SCHEMAS}})` | `s.name IN ({{SCHEMAS}}) AND s.name NOT IN (N'Audit')` |
| `dependencies` | `(s1.name IN ({{SCHEMAS}}) OR d.referenced_schema_name IN ({{SCHEMAS}}))` | add `AND s1.name NOT IN (N'Audit') AND d.referenced_schema_name NOT IN (N'Audit')` |

Keep `{{SCHEMAS}}` in every Phase 2 query: a query without it runs verbatim and
ignores the wizard's schema selection (the output channel logs a warning). The
file is read at each import, so an edit applies to the next import.

## Expected columns — the contract

Each query must return the columns below. Column matching is case-insensitive and extra columns are ignored. The host currently validates `platform-info` before using it; the main extraction queries have no complete preflight check, so test custom result shapes before production use.

### `schema-preview` — schema object counts (Phase 1)

| Column | Type | Description |
|--------|------|-------------|
| `schema_name` | string | Schema name |
| `type_code` | string | Object type code (see table below) |
| `object_count` | int | Number of objects of that type in the schema |

### `all-objects` — full object catalog (Phase 1, optional)

Used to identify dependencies into unselected schemas and preserve schema casing.

| Column | Type | Description |
|--------|------|-------------|
| `schema_name` | string | Schema name |
| `object_name` | string | Object name |
| `type_code` | string | Object type code |

### `nodes` — objects and DDL (Phase 2)

| Column | Type | Description |
|--------|------|-------------|
| `schema_name` | string | Schema name (`dbo`, `Sales`, etc.) |
| `object_name` | string | Object name |
| `type_code` | string | Object type code (see table below) |
| `body_script` | string/null | DDL body for SPs, views, functions. NULL for tables. |

**Valid `type_code` values** — these are the standard `sys.objects.type` codes; the only deviation is `ET` for external tables (collapsed from `U` + `is_external = 1`):

| Code | Object Type |
|------|-------------|
| `U` | Table |
| `V` | View |
| `P` | Stored Procedure |
| `FN` | Scalar Function |
| `IF` | Inline Table-Valued Function |
| `TF` | Multi-Statement Table-Valued Function |
| `ET` | External Table (PolyBase, Synapse Dedicated SQL Pool, Fabric) |

### `platform-info` — platform detection

Returns one row identifying the platform stored in the model. If unavailable,
the extension tries server metadata, then records `Unknown database platform`.

| Column | Type | Description |
|--------|------|-------------|
| `engine_edition` | int | `SERVERPROPERTY('EngineEdition')` — identifies the platform family |
| `major_version` | int | `SERVERPROPERTY('ProductMajorVersion')` — used to resolve on-prem SQL Server year |
| `edition` | string | `SERVERPROPERTY('Edition')` — fallback label when version is unrecognised |
| `identifier_collation` *(optional)* | string/null | Effective catalog collation of `sys.schemas.name`, used with `identifier_comparison_style` to validate identifier case policy. |
| `identifier_comparison_style` *(optional)* | int/null | `COLLATIONPROPERTY(..., 'ComparisonStyle')` for that catalog collation; missing or conflicting evidence retains case-insensitive IDs. |

**`engine_edition` mapping:**

| Value | Platform |
|-------|---------|
| 5 | Azure SQL Database |
| 6 | Synapse Dedicated Pool |
| 8 | Azure SQL Managed Instance |
| 9 | Azure SQL Edge |
| 11 | Fabric Data Warehouse |
| 12 | SQL Database in Fabric |
| any other value | Resolved from `major_version` to an on-prem SQL Server year (2000-2025); an unrecognised version falls back to `edition`, then to unknown |

### `columns` — table column metadata (Phase 2)

Used for the table design preview in the SQL viewer.

| Column | Type | Description |
|--------|------|-------------|
| `schema_name` | string | Schema name |
| `table_name` | string | Table name |
| `ordinal` | int | Column position (1-based) |
| `column_name` | string | Column name |
| `type_name` | string | Data type (`int`, `nvarchar`, etc.); CLR types such as `hierarchyid`, `geography` and `geometry` use their user-type name |
| `max_length` | int | Max length in bytes (-1 = `max`) |
| `precision` | int | Numeric precision |
| `scale` | int | Numeric scale |
| `is_nullable` | bit/bool | Allows NULL |
| `is_identity` | bit/bool | Identity column |
| `is_computed` | bit/bool | Computed column |
| `pk_ordinal` *(optional)* | int/null | Primary key ordinal (1-based). NULL for non-PK columns. When present, drives the `PK` / `PK1` / `PK2` badges in the table design view. Not validated; if absent, badges are not rendered. |

### `constraints` — table constraints (Phase 2, optional)

Returns FK, UQ, and CK constraint metadata via `UNION ALL`, distinguished by
`constraint_type`. The query currently executes, but the host omits its result
when constructing `DmvResults`; consequently these constraints are not shown.

CK rows are **column-level only** (`parent_column_id != 0`). Table-level CHECK constraints are not yet returned by the built-in query; see comments in `assets/dmvQueries.yaml` for context.

| Column | Type | Description |
|--------|------|-------------|
| `schema_name` | string | Table schema |
| `table_name` | string | Table name |
| `constraint_type` | string | `FK`, `UQ`, or `CK` |
| `constraint_name` | string | Constraint name |
| `column_name` | string | Column name |
| `column_ordinal` | int/null | Key order (FK, UQ only) |
| `ref_schema` | string/null | Referenced schema (FK only) |
| `ref_table` | string/null | Referenced table (FK only) |
| `ref_column` | string/null | Referenced column (FK only) |
| `on_delete` | string/null | Referential action (FK only): `NO_ACTION`, `CASCADE`, `SET_NULL`, `SET_DEFAULT` |

### `dependencies` — object-level references (Phase 2)

| Column | Type | Description |
|--------|------|-------------|
| `referencing_schema` | string | Schema of the object that references |
| `referencing_name` | string | Name of the object that references |
| `referenced_schema` | string | Schema of the referenced object |
| `referenced_name` | string | Name of the referenced object |
| `referenced_database` *(optional)* | string/null | Database name for cross-database references. Used to build `[db].[schema].[object]` identifiers. Not validated — omit if your DB engine doesn't expose it. |
| `referenced_server` *(optional)* | string/null | Server name for a declared cross-server column-expression reference. |
| `referencing_column` *(optional)* | string/null | Exact catalog column name resolved from `referencing_id` and `referencing_minor_id`; absent for object-level dependencies. |
| `referenced_column` *(optional)* | string/null | Exact referenced column name resolved from local `referenced_id` and `referenced_minor_id`, when supplied. |
| `referenced_type` *(optional)* | string/null | Exact local `sys.objects.type` code, such as `FN` for a SQL scalar function or `IF` for an inline table-valued function. External references remain unclassified. |

The built-in query retains these fields with left joins, preserving object-level dependency rows.
Only a supplied `referencing_column` that matches a loaded column receives
`ColumnDef.expressionDependencies`; an object-level dependency never binds a function to every output.
References preserve server/database/schema/object/column qualification, with SQL identifier quoting.
These declarations identify dependencies, not semantic value contributors. Custom queries that omit
the optional fields retain their existing behavior.

SQL Server can report object-level references with `referencing_minor_id = 0`; this does not identify
which projected view output invokes a function. This adapter leaves such output bindings unresolved.
Column dependency availability also differs for schema-bound and non-schema-bound objects; see
[Microsoft's catalog contract](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-sql-expression-dependencies-transact-sql).

The [column-tracing contract](ARCHITECTURE.md) supports an explicit function
investigation request carrying caller SQL and real loaded output columns when
catalog projection metadata is absent.
It does not change this adapter's dependency meaning or populate
`expressionDependencies` from object-level rows. Live-DB and DACPAC callers can
therefore supply different declaration coverage without authorizing guessed
column edges. Supplied contributor mappings still require SQL-grounded review;
metadata and routing validation do not establish their completeness.

## What you can customise

- **WHERE filters** — restrict to specific schemas, object types, or naming patterns.
- **JOINs** — add joins for additional metadata your queries can return; extra columns are ignored.
- **Platform-specific syntax** — adapt queries for vendor dialects (Synapse `LABEL`, Fabric workarounds for unsupported DMVs, etc.).

## What must stay fixed

- **`version`** — must match the shipped YAML. A missing or different version
  triggers a warning and built-in fallback. After an upgrade, run **Data
  Lineage: Create DMV Queries** and re-apply your edits to the current version.
- **Runtime query names** — the current import path requires
  `schema-preview`, `nodes`, `columns`, and `dependencies`. `all-objects`,
  `constraints`, and `platform-info` are optional definitions; server
  metadata is tried when `platform-info` is unavailable, and a
  missing `all-objects` leaves cross-schema references unclassified.
- **Required column names** — the columns listed above must be present in the result set.
- **Column semantics** — `type_code` must return `sys.objects.type` codes (or `ET` for external tables).
- **`{{SCHEMAS}}` placeholder** — use it in Phase 2 SQL to apply the wizard's
  schema selection. If it is absent, the loader warns but executes the custom
  SQL verbatim rather than enforcing a filter.

## Fallback behaviour

- **No YAML configured** → uses built-in queries silently.
- **YAML missing or invalid** → uses built-in queries + VS Code warning dialog + log entry to the Output channel.
- **YAML `version` does not match the shipped file** (including a missing `version`) → uses built-in queries + VS Code warning dialog naming both versions + log entry to the Output channel; re-scaffold and re-apply your edits.
- **YAML valid but missing required query names** → an early warning lists the missing names; import fails when the active path needs a missing result.
- **Main query returns wrong columns** → extraction may be empty or incomplete; there is no complete preflight validator for these result sets. `platform-info` is validated and falls back to MSSQL server metadata when unusable.
- **Built-in YAML itself fails** (should not happen) → error logged, `db-error` sent to the webview.

## Known limitations

| Limitation | Reason |
|------------|--------|
| Dynamic SQL dependencies not captured | `sys.sql_expression_dependencies` only tracks static references. |
| Remote database internals not introspected | Three- or four-part references can surface as virtual cross-database nodes when metadata exposes database/schema/object names, but DMV import remains scoped to the connected database. |
| Unqualified / unresolved references may be excluded | Built-in dependency SQL filters unresolved rows; parser fallback can recover some schema-qualified references from SQL bodies, but default-schema ambiguity is not reliable. |

These are metadata-source limits rather than UI-only gaps.

## Reference

- Built-in YAML: [`assets/dmvQueries.yaml`](../assets/dmvQueries.yaml)
- Microsoft DMV catalogue: <https://learn.microsoft.com/sql/relational-databases/system-dynamic-management-views/system-dynamic-management-views>
