# Custom DMV Queries

Live-database ingestion uses Dynamic Management View (DMV) queries defined in [`assets/dmvQueries.yaml`](../assets/dmvQueries.yaml). Every query, every column, and every WHERE filter is yours to read, audit, and override — nothing about the SQL is hidden inside the extension.

## Setup

1. Open the **Command Palette** (`Ctrl+Shift+P`) and run **Data Lineage: Create DMV Queries** — copies the built-in YAML into your workspace as `dmvQueries.yaml`.
2. Set `dataLineageViz.dmvQueriesFile` to `dmvQueries.yaml` in VS Code Settings (`Ctrl+,`, search "dataLineageViz").
3. Edit the SQL — add WHERE filters, adjust JOINs, swap a query for a vendor variant.
4. The YAML is validated on every DB import. Anything wrong falls back to the built-in queries with a VS Code warning.

## Prerequisites

- **MSSQL extension** (`ms-mssql.mssql`) installed and a connection profile configured.
- **`VIEW DEFINITION`** permission on the target database.
- Supported platforms: SQL Server 2016+, Azure SQL, Fabric Data Warehouse, Synapse Dedicated SQL Pool.

## What gets executed and when — read the SQL yourself

Every executed DMV query is logged to the **Data Lineage Viz** Output channel with the `[DB]` category. To see what hit your database:

1. `View → Output → Data Lineage Viz`.
2. Set the channel log level to **Debug** (gear icon → Set Log Level → Debug). Phase milestones are at INFO; the per-query SQL is at DEBUG.
3. Open the wizard and run an import.
4. Each query is logged on execution as `[DB] Executing <name> (step/total) — SQL: <first 300 chars>`. Copy / paste into SSMS to validate before scaling to a production server.

The 300-character cap is intentional for log hygiene; for the full SQL refer to [`assets/dmvQueries.yaml`](../assets/dmvQueries.yaml) — the YAML in the Output log is the verbatim text the extension just executed (with `{{SCHEMAS}}` already expanded).

Nothing runs automatically in the background. The seven queries fire only during import and follow this two-phase order:

| Phase | Queries | When |
|-------|---------|------|
| Phase 1 | `schema-preview`, `all-objects`, `platform-info` (optional) | Always — runs first to populate the schema-selection wizard and the global object catalog. |
| Phase 2 | `nodes`, `columns`, `constraints` (optional), `dependencies` | After schema selection — filtered to the selected schemas via the `{{SCHEMAS}}` placeholder. |

Phase 2 queries use the placeholder `{{SCHEMAS}}` which the extension expands to the comma-separated, single-quoted schema list before execution (e.g. `'dbo','Sales'`). The SQL author controls *where* the filter is applied — TypeScript does not rewrite the query.

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
  - name: all-objects      # Phase 1 — full catalog (no DDL)
    phase: 1
    description: "..."
    sql: |
      SELECT ...
  - name: platform-info    # Phase 1 — DB platform detection (optional)
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

## Required columns — the contract

Each query must return specific columns (validated at runtime). Column names are case-insensitive. Extra columns are ignored.

### `schema-preview` — schema object counts (Phase 1)

| Column | Type | Description |
|--------|------|-------------|
| `schema_name` | string | Schema name |
| `type_code` | string | Object type code (see table below) |
| `object_count` | int | Number of objects of that type in the schema |

### `all-objects` — full object catalog (Phase 1)

Runs alongside `schema-preview`. Returns all objects across **all schemas** (no DDL, no columns). Used in Phase 2 to classify cross-schema SP dependencies as "known" vs "unresolved", and to provide correct schema casing in the dependency details panel.

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
| `ET` | External Table (PolyBase, Synapse, Fabric) |

### `platform-info` — database platform detection (Phase 1, optional)

Returns a single row identifying the database engine. Used to populate the `dbPlatform` field on the model (displayed in the connection info tooltip). If omitted, `dbPlatform` is left blank.

| Column | Type | Description |
|--------|------|-------------|
| `engine_edition` | int | `SERVERPROPERTY('EngineEdition')` — identifies the platform family |
| `major_version` | int | `SERVERPROPERTY('ProductMajorVersion')` — used to resolve on-prem SQL Server year |
| `edition` | string | `SERVERPROPERTY('Edition')` — fallback label when version is unrecognised |

**`engine_edition` mapping:**

| Value | Platform |
|-------|---------|
| 5 | Azure SQL Database |
| 6 | Synapse Dedicated Pool |
| 8 | Azure SQL Managed Instance |
| 9 | Azure SQL Edge |
| 11 | Fabric Data Warehouse |
| 12 | SQL Database in Fabric |
| 1–4 | On-prem SQL Server (resolved via `major_version`) |

### `columns` — table column metadata (Phase 2)

Used for the table design preview in the SQL viewer.

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
| `pk_ordinal` *(optional)* | int/null | Primary key ordinal (1-based). NULL for non-PK columns. When present, drives the `PK` / `PK1` / `PK2` badges in the table design view. Not validated; if absent, badges are not rendered. |

### `constraints` — table constraints (Phase 2, optional)

Returns FK, UQ, and CK constraint metadata via `UNION ALL`, distinguished by `constraint_type`. If omitted, the table design view still works — constraints are simply not shown.

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

## What you can customise

- **WHERE filters** — restrict to specific schemas, object types, or naming patterns.
- **JOINs** — add joins for additional metadata your queries can return; extra columns are ignored.
- **Platform-specific syntax** — adapt queries for vendor dialects (Synapse `LABEL`, Fabric workarounds for unsupported DMVs, etc.).

## What must stay fixed

- **Query names** — must be exactly `schema-preview`, `all-objects`, `nodes`, `columns`, `dependencies` (required); `constraints`, `platform-info` (optional).
- **Required column names** — the columns listed above must be present in the result set.
- **Column semantics** — `type_code` must return `sys.objects.type` codes (or `ET` for external tables).
- **`{{SCHEMAS}}` placeholder** — Phase 2 queries must contain it, otherwise the schema selection from the wizard cannot be applied.

## Validation

Column contracts are enforced at runtime. If a required column is missing, the error is explicit:

> Query 'nodes' is missing required columns: type_code, body_script.

## Fallback behaviour

- **No YAML configured** → uses built-in queries silently.
- **YAML missing or invalid** → uses built-in queries + VS Code warning dialog + log entry to the Output channel.
- **YAML valid but missing required query names** → early warning at load time listing what's missing; hard error at execution time.
- **Query returns wrong columns** → error message identifying the missing columns.
- **Built-in YAML itself fails** (should not happen) → error logged, `db-error` sent to the webview.

## Known limitations

| Limitation | Reason |
|------------|--------|
| Dynamic SQL dependencies not captured | `sys.sql_expression_dependencies` only tracks static references. |
| Cross-database references not captured | DMVs are database-scoped. |
| Unresolved references excluded | `WHERE d.referenced_schema_name IS NOT NULL AND d.referenced_entity_name IS NOT NULL` filters unqualified / unresolved references. |

These match `.dacpac` ingestion behaviour exactly — not new gaps.

## Reference

- Built-in YAML: [`assets/dmvQueries.yaml`](../assets/dmvQueries.yaml)
- Microsoft DMV catalogue: <https://learn.microsoft.com/sql/relational-databases/system-dynamic-management-views/system-dynamic-management-views>
