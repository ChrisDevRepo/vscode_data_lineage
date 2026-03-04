# Custom DMV Queries

The extension can import from a database via the MSSQL extension using DMV (Dynamic Management View) queries. The SQL is defined in a YAML file that you can customize.

## Setup

1. Run **Data Lineage: Create DMV Queries** to scaffold a `dmvQueries.yaml` in your workspace
2. Set `dataLineageViz.dmvQueriesFile` in VS Code settings to point to your file
3. Edit the SQL — add WHERE filters, adjust JOINs, etc.

## Prerequisites

- **MSSQL extension** (`ms-mssql.mssql`) installed and a connection profile configured
- **`VIEW DEFINITION`** permission on the target database
- Supported platforms: SQL Server 2016+, Azure SQL, Fabric Data Warehouse, Synapse Dedicated SQL Pool

## YAML Structure

```yaml
version: 1
queries:
  - name: schema-preview  # Phase 1 — schema counts for selection wizard
    description: "..."
    sql: |
      SELECT ...
  - name: all-objects     # Phase 1 — full catalog (no DDL)
    description: "..."
    sql: |
      SELECT ...
  - name: nodes           # Phase 2 — DDL for selected schemas
    description: "..."
    sql: |
      SELECT ...
  - name: columns         # Phase 2 — column metadata
    description: "..."
    sql: |
      SELECT ...
  - name: dependencies    # Phase 2 — object-level references
    description: "..."
    sql: |
      SELECT ...
```

**Five queries** are required, identified by `name`. They run in two phases:

| Phase | Queries | When |
|-------|---------|------|
| Phase 1 | `schema-preview`, `all-objects` | Always — runs first to populate the schema selection wizard and the full object catalog |
| Phase 2 | `nodes`, `columns`, `dependencies` | After schema selection — filtered to selected schemas only |

## Required Columns

Each query must return specific columns (validated at runtime). Column names are case-insensitive. Extra columns are ignored.

### `schema-preview` — Schema Object Counts (Phase 1)

| Column | Type | Description |
|--------|------|-------------|
| `schema_name` | string | Schema name |
| `type_code` | string | Object type code (see table below) |
| `object_count` | int | Number of objects of that type in the schema |

### `all-objects` — Full Object Catalog (Phase 1)

Runs alongside `schema-preview`. Returns all objects across **all schemas** (no DDL, no columns). Used in Phase 2 to classify cross-schema SP dependencies as "known" vs "unresolved", and to provide correct schema casing in the dependency details panel.

| Column | Type | Description |
|--------|------|-------------|
| `schema_name` | string | Schema name |
| `object_name` | string | Object name |
| `type_code` | string | Object type code |

### `nodes` — Objects and DDL (Phase 2)

| Column | Type | Description |
|--------|------|-------------|
| `schema_name` | string | Schema name (`dbo`, `Sales`, etc.) |
| `object_name` | string | Object name |
| `type_code` | string | Object type code (see table below) |
| `body_script` | string/null | DDL body for SPs, views, functions. NULL for tables. |

**Valid `type_code` values:**

| Code | Object Type |
|------|-------------|
| `U` | Table |
| `V` | View |
| `P` | Stored Procedure |
| `FN` | Scalar Function |
| `IF` | Inline Table-Valued Function |
| `TF` | Multi-Statement Table-Valued Function |

### `columns` — Table Column Metadata

Used for the table design preview in the SQL viewer.

| Column | Type | Description |
|--------|------|-------------|
| `schema_name` | string | Schema name |
| `table_name` | string | Table name |
| `ordinal` | int | Column position (1-based) |
| `column_name` | string | Column name |
| `type_name` | string | Data type (`int`, `nvarchar`, etc.) |
| `max_length` | int | Max length in bytes (-1 = max) |
| `precision` | int | Numeric precision |
| `scale` | int | Numeric scale |
| `is_nullable` | bit/bool | Allows NULL |
| `is_identity` | bit/bool | Identity column |
| `is_computed` | bit/bool | Computed column |

### `dependencies` — Object-Level References (Phase 2)

| Column | Type | Description |
|--------|------|-------------|
| `referencing_schema` | string | Schema of the object that references |
| `referencing_name` | string | Name of the object that references |
| `referenced_schema` | string | Schema of the referenced object |
| `referenced_name` | string | Name of the referenced object |

## What You Can Customize

- **WHERE filters** — restrict to specific schemas, object types, or naming patterns
- **JOINs** — add additional joins for metadata you need
- **Platform-specific syntax** — adapt queries for your SQL dialect

## What Must Stay Fixed

- **Query names** — must be exactly `schema-preview`, `all-objects`, `nodes`, `columns`, `dependencies`
- **Required column names** — the columns listed above must be present in the result set
- **Column semantics** — `type_code` must return standard `sys.objects.type` codes

## Validation

Column contracts are enforced at runtime. If a required column is missing, you get a clear error:

> Query 'nodes' is missing required columns: type_code, body_script.

## Fallback Behavior

- **No YAML configured** — uses built-in queries silently
- **YAML missing or invalid** — uses built-in queries + shows a warning
- **Query returns wrong columns** — error message identifying the missing columns

## Known Limitations

| Limitation | Reason |
|------------|--------|
| Dynamic SQL dependencies not captured | `sys.sql_expression_dependencies` only tracks static references |
| Cross-database references not captured | DMVs are database-scoped |
| Unresolved references excluded | `WHERE d.referenced_schema_name IS NOT NULL AND d.referenced_entity_name IS NOT NULL` filters unqualified/unresolved references |

These match dacpac behavior exactly — not new gaps.
