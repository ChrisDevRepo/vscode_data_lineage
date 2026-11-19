# Custom DMV Queries

Live-database import uses catalog and Dynamic Management View (DMV) queries defined in [`assets/dmvQueries.yaml`](../assets/dmvQueries.yaml). The built-in SQL can be read in that file and overridden with a copy in the workspace.

## Setup

1. Open the **Command Palette** (`Ctrl+Shift+P`) and run **Data Lineage: Create DMV Queries** — copies the built-in YAML into your workspace as `dmvQueries.yaml`.
2. Set `dataLineageViz.dmvQueriesFile` to `dmvQueries.yaml` in VS Code Settings (`Ctrl+,`, search "dataLineageViz").
3. Edit the SQL, for example add WHERE filters, adjust JOINs or swap a query for a vendor variant.
4. The file is read at the start of each import step, so an edit applies to the next import. If the file is missing or unreadable, is invalid YAML, or has no usable query entries, the built-in queries are used and a warning is shown. An individual entry without a `name` or `sql` is skipped; the rest of the file stays in use.

In a workspace that is not trusted, a workspace value of `dataLineageViz.dmvQueriesFile` is ignored until the workspace is trusted.

## Prerequisites

- A saved database connection. See [Connections](../SECURITY.md#connections) for sign-in methods and credential storage.
- Permissions: `VIEW DEFINITION` on the database for lineage; `SELECT` on a table for its statistics. Custom queries may need more.
- Platforms listed in the YAML: SQL Server 2016+, Azure SQL, Fabric Data Warehouse, Synapse Dedicated SQL Pool.
- Each import query is limited by `dataLineageViz.dmvQueryTimeout` (default 120 seconds, range 10-600), except `platform-info` during import (see below).

## Query execution

Queries are logged to the **Data Lineage Viz** Output channel with the `[DB]` category. To see what was sent to the database:

1. `View → Output → Data Lineage Viz`.
2. Set the channel log level to **Debug** (gear icon → Set Log Level → Debug). Phase milestones are at INFO; the SQL is at DEBUG.
3. Open the wizard and run an import.
4. Each query is logged as `[DB] Executing <name> (step/total) — SQL: <first 300 chars>`.

The log shows the first 300 characters. The full built-in SQL is in [`assets/dmvQueries.yaml`](../assets/dmvQueries.yaml). Custom SQL is sent as written.

Queries run during an import and when table statistics are requested:

| When | Queries | Notes |
|------|---------|-------|
| Import, Phase 1 (schema list) | `schema-preview`, `platform-info` | `schema-preview` fills the schema-selection wizard. |
| Import, Phase 2 (after schema selection) | `platform-info`, `all-objects`, then `nodes`, `columns`, `constraints`, `dependencies` | |
| Table statistics, on request | `platform-info`, a row-count query, one aggregate `SELECT` on the table | The last two are built into the extension and are not in the YAML. |

- `platform-info` identifies the platform. During import it is limited to 10 seconds (or `dmvQueryTimeout` if lower). If it is missing, fails or returns no row, the import continues and the platform is recorded as `Unknown database platform`.
- Every table statistics request runs `platform-info` first, with a custom file too, under `dmvQueryTimeout`; it is not written to the `[DB]` log. Its `engine_edition` decides between `TOP` (Fabric) and `TABLESAMPLE` sampling. If the query is missing or fails, table statistics fail with an error.
- `all-objects` lists every object in all schemas, without DDL or columns, so references into unselected schemas are classified as known cross-schema references with the catalog's schema casing. If it is missing or fails, those references stay unresolved and the import continues.
- A query with `phase: 2`, or without a `phase`, runs in Phase 2 with `{{SCHEMAS}}` expanded. This includes queries the extension does not use; their results are ignored. `phase: 1` marks a query that is not schema-filtered.
- The row-count query reads `sys.partitions`. The aggregate query reads the table and is sampled when the row count is above `dataLineageViz.tableStatistics.sampleThreshold`. Their SQL shapes are in [`PROFILING_PATTERNS.md`](PROFILING_PATTERNS.md); settings are in [`FEATURES.md`](FEATURES.md#table-statistics). Both use `dataLineageViz.tableStatistics.queryTimeout`.

Connections and sessions:

- The import wizard opens one connection for Phase 1 and a new one for Phase 2. Reopening a saved project runs both phases on one connection. Each statistics request opens its own connection and closes it afterwards.
- When a query times out, the extension cancels it on the server.
- Sessions report the application name `Data Lineage Viz` and set `ApplicationIntent=ReadOnly`. This is a routing hint for availability groups and read scale-out; it does not block writes, so use a login with read permissions only.

The Phase 2 queries use `{{SCHEMAS}}`, which the extension expands to the comma-separated list of selected schemas as N-prefixed string literals (for example `N'dbo', N'Sales'`) before the query is sent. The SQL author decides where the filter is applied; the extension does not otherwise change custom SQL.

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

Keep `{{SCHEMAS}}` in every Phase 2 query: a query without it runs as written and
ignores the wizard's schema selection (a warning is logged).

## Expected columns — the contract

A query is expected to return the columns below. Column names are matched case-insensitively and extra columns are ignored. Only `platform-info` is checked for its columns before use. For the other queries, a missing column can give empty or incomplete results, so test a custom query on a small database first.

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

Returns one row identifying the platform stored in the model. If the query is
unusable, the platform is recorded as `Unknown database platform`.

| Column | Type | Description |
|--------|------|-------------|
| `engine_edition` | int | `SERVERPROPERTY('EngineEdition')` — identifies the platform family |
| `major_version` | int | `SERVERPROPERTY('ProductMajorVersion')` — used to resolve on-prem SQL Server year |
| `edition` | string | `SERVERPROPERTY('Edition')` — fallback label when version is unrecognised |
| `identifier_collation` *(optional)* | string | Collation of the `sys.schemas` names. Together with `identifier_comparison_style`, it decides whether identifiers that differ only in case are kept apart. |
| `identifier_comparison_style` *(optional)* | int | `COLLATIONPROPERTY(..., 'ComparisonStyle')` of that collation. |

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

Column metadata for tables, views, table-valued functions and external tables.

| Column | Type | Description |
|--------|------|-------------|
| `schema_name` | string | Schema name |
| `table_name` | string | Table name |
| `ordinal` | int | Column position (1-based) |
| `column_name` | string | Column name |
| `type_name` | string | Data type (`int`, `nvarchar`, etc.) |
| `max_length` | int | Max length in bytes (-1 = `max`) |
| `precision` | int | Numeric precision |
| `scale` | int | Numeric scale |
| `is_nullable` | bit/bool | Allows NULL |
| `is_identity` | bit/bool | Identity column |
| `is_computed` | bit/bool | Computed column |
| `pk_ordinal` *(optional)* | int/null | Primary key ordinal (1-based). NULL for non-PK columns. Not validated. |

### `constraints` — table constraints (Phase 2, optional)

Returns FK, UQ, and CK constraint metadata via `UNION ALL`, distinguished by
`constraint_type`. The query is executed, but its result is not currently used,
so constraints are not shown for a live database.

CK rows are column-level only (`parent_column_id != 0`); table-level CHECK constraints are not returned.

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
| `referencing_column` *(optional)* | string/null | Catalog column name resolved from `referencing_id` and `referencing_minor_id`; absent for object-level dependencies. |
| `referenced_column` *(optional)* | string/null | Referenced column name resolved from local `referenced_id` and `referenced_minor_id`, when supplied. |
| `referenced_type` *(optional)* | string/null | Local `sys.objects.type` code, such as `FN` for a SQL scalar function or `IF` for an inline table-valued function. External references remain unclassified. |

The built-in query keeps these fields with left joins, so object-level dependency rows are preserved. A supplied `referencing_column` that matches a loaded column is recorded as a dependency of that column. These rows are declared dependencies from the catalog. They do not show which values flow into an output column.

Column-level dependency data differs for schema-bound and non-schema-bound objects; see [Microsoft's documentation](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-sql-expression-dependencies-transact-sql). A custom query that omits the optional columns still works.

## What you can customise

- **WHERE filters** — restrict to specific schemas, object types, or naming patterns.
- **JOINs** — add joins; extra result columns are ignored.
- **Platform-specific syntax** — adapt queries for vendor dialects (Synapse `LABEL`, Fabric workarounds for unsupported DMVs, etc.).

## What must stay fixed

- **`version`** — must match the shipped YAML. A missing or different version
  triggers a warning and the built-in queries are used. After an upgrade, run **Data
  Lineage: Create DMV Queries** and re-apply your edits to the new file.
- **Query names** — the import uses `schema-preview`, `nodes`, `columns` and
  `dependencies`; a file without them warns and the import can fail.
  `all-objects`, `constraints` and `platform-info` are optional for import;
  table statistics need `platform-info`.
- **Column names** — the columns listed above need to be in the result set.
- **Column semantics** — `type_code` returns `sys.objects.type` codes (or `ET` for external tables).
- **`{{SCHEMAS}}` placeholder** — use it in Phase 2 SQL to apply the wizard's
  schema selection. Without it the query runs as written and returns what its SQL selects.

## Known limitations

| Limitation | Reason |
|------------|--------|
| Dynamic SQL dependencies are not listed | `sys.sql_expression_dependencies` records static references. |
| Other databases are not read | Three- or four-part references can appear as external nodes, but the import reads only the connected database. |
| Unqualified references can be missing | The built-in dependency query returns only references written with a schema; `referenced_schema_name` is NULL for unqualified references. |

## Reference

- Built-in YAML: [`assets/dmvQueries.yaml`](../assets/dmvQueries.yaml)
- Microsoft DMV catalogue: <https://learn.microsoft.com/sql/relational-databases/system-dynamic-management-views/system-dynamic-management-views>
