# DMV queries

Reference for DBAs: every statement a database import sends, what it reads and what it returns. The SQL is in [`assets/dmvQueries.yaml`](../assets/dmvQueries.yaml) and can be replaced by a custom file.

## Connection

| Item | Value |
|---|---|
| Authentication | SQL login or Microsoft Entra ID |
| Application intent | `ReadOnly` |
| Encryption | On by default; required for Entra ID |
| Permission | `VIEW DEFINITION` on the database |
| Statements | `SELECT` on catalog views and `SERVERPROPERTY` only; no writes, no temp objects, no user-table reads |
| Timeout | `dataLineageViz.dmvQueryTimeout` per query (default 120 s) |
| Platforms | SQL Server 2016 or later, Azure SQL, Fabric Data Warehouse, Synapse Dedicated SQL Pool |

Table statistics use the same connection settings with different statements; see [`PROFILING_PATTERNS.md`](PROFILING_PATTERNS.md).

## Query execution

| Step | Query | When |
|---|---|---|
| Phase 1 | `schema-preview` | When an import starts, to fill the schema-selection wizard. |
| Platform detection | `platform-info` | After the preview, and again at the start of Phase 2 (10-second limit). |
| Object catalog | `all-objects` | Once per import, unfiltered. |
| Phase 2 | `nodes`, `columns`, `constraints`, `dependencies` | After you select schemas. |

`{{SCHEMAS}}` in Phase 2 queries expands to the selected schemas as Unicode literals, for example `N'dbo', N'Sales'`.

**Object filter.** Unless noted, queries return only user objects of type `U` (table), `V` (view), `P` (procedure), `FN` (scalar function), `IF` (inline table function), `TF` (table function) and `ET` (external table, `sys.tables.is_external = 1`). They exclude `is_ms_shipped = 1`, the `sys` and `INFORMATION_SCHEMA` schemas, and objects with the extended property `microsoft_database_tools_support`.

### `schema-preview`

| | |
|---|---|
| Reads | `sys.objects`, `sys.schemas`, `sys.tables`, `sys.extended_properties` |
| Filter | Object filter; all schemas |
| Returns | One row per schema and type: `schema_name`, `type_code`, `object_count` |

### `platform-info`

| | |
|---|---|
| Reads | `SERVERPROPERTY('EngineEdition')`, `SERVERPROPERTY('ProductMajorVersion')`, `SERVERPROPERTY('Edition')`; collation of `sys.schemas.name` |
| Returns | One row: `engine_edition`, `major_version`, `edition`, `identifier_collation`, `identifier_comparison_style` |
| Used for | Platform label, case sensitivity of names, and the sampling method of table statistics |

If it is missing, fails or returns nothing, the import continues with `Unknown database platform`.

### `all-objects`

| | |
|---|---|
| Reads | `sys.objects`, `sys.schemas`, `sys.tables`, `sys.extended_properties` |
| Filter | Object filter; all schemas; no SQL bodies |
| Returns | One row per object: `schema_name`, `object_name`, `type_code` |
| Used for | Recognizing references into schemas you did not select |

### `nodes`

| | |
|---|---|
| Reads | `sys.objects`, `sys.schemas`, `sys.tables`, `sys.sql_modules`, `sys.extended_properties` |
| Filter | Object filter; `s.name IN ({{SCHEMAS}})` |
| Returns | One row per object: `schema_name`, `object_name`, `type_code`, `body_script` (`sys.sql_modules.definition`; NULL for tables and for bodies the login cannot read) |

### `columns`

| | |
|---|---|
| Reads | `sys.columns`, `sys.objects`, `sys.schemas`, `sys.indexes`, `sys.index_columns`, `sys.extended_properties` |
| Filter | Types `U`, `V`, `IF`, `TF`, `ET`; `s.name IN ({{SCHEMAS}})` |
| Returns | One row per column, ordered by schema, object and `column_id`: `schema_name`, `table_name`, `ordinal`, `column_name`, `type_name`, `max_length` (-1 = max), `precision`, `scale`, `is_nullable`, `is_identity`, `is_computed`, `pk_ordinal` (key position in the primary key, else NULL) |

### `constraints`

| | |
|---|---|
| Reads | `sys.foreign_keys`, `sys.foreign_key_columns`, `sys.key_constraints`, `sys.index_columns`, `sys.check_constraints`, `sys.columns`, `sys.objects`, `sys.schemas` |
| Filter | Parent table in `{{SCHEMAS}}`; unique constraints only (`type = 'UQ'`); check constraints defined on a column (`parent_column_id <> 0`) |
| Returns | One row per constraint column: `schema_name`, `table_name`, `constraint_type` (`FK`, `UQ`, `CK`), `constraint_name`, `column_name`, `column_ordinal`; for `FK` also `ref_schema`, `ref_table`, `ref_column`, `on_delete` |

### `dependencies`

| | |
|---|---|
| Reads | `sys.sql_expression_dependencies`, `sys.objects`, `sys.schemas`, `sys.columns` |
| Filter | Schema-qualified references only (`referenced_schema_name` and `referenced_entity_name` not NULL); `referenced_class = 1`; referencing object not `is_ms_shipped`; referencing or referenced schema in `{{SCHEMAS}}` |
| Returns | One row per reference: `referencing_schema`, `referencing_name`, `referenced_schema`, `referenced_name`, `referenced_database`, `referenced_server`, `referencing_column`, `referenced_column`, `referenced_type` |

`sys.sql_expression_dependencies` does not record dynamic SQL or schema-less names; those references come only from the [parse rules](PARSE_RULES.md), if at all.

## Custom queries

### Setup

1. Run **Data Lineage: Create DMV Queries** from the Command Palette. It copies the built-in YAML to `dmvQueries.yaml` in the first workspace folder; an existing file is opened, not overwritten.
2. Set `dataLineageViz.dmvQueriesFile` to that file in VS Code Settings.
3. Edit the SQL, for example to add `WHERE` filters. The file is read again at every import.

### YAML structure

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

A custom query must return the column names listed above; names match case-insensitively and extra columns are ignored. Only `platform-info` is checked, so a wrong shape elsewhere can leave the model empty or incomplete. Keep `{{SCHEMAS}}` in every Phase 2 query (without it a warning is logged and the selection is ignored), and keep the `ORDER BY` of `columns`, because columns are shown in row order. Without `referenced_database` and `referenced_server`, cross-database references are not recognized.

### Example: exclude a schema

Add the same predicate to every query that returns objects; one query alone leaves the schema reachable.

| Query | Restricted predicate |
|---|---|
| `schema-preview`, `all-objects` | `s.name NOT IN ('sys','INFORMATION_SCHEMA', N'Audit')` |
| `nodes`, `columns`, `constraints` | `s.name IN ({{SCHEMAS}}) AND s.name NOT IN (N'Audit')` |
| `dependencies` | add `AND s1.name NOT IN (N'Audit') AND d.referenced_schema_name NOT IN (N'Audit')` |

### Errors and fallback

| Situation | Result |
|---|---|
| No file configured | Built-in queries. |
| File missing, unreadable, invalid YAML or no usable query | Built-in queries and a warning. |
| `version` missing or different | Built-in queries and a warning naming both versions. |
| A required query is missing | A warning lists it; the import fails at that step. |

## Check it works

Open **View → Output → Data Lineage Viz**, set the log level to **Debug**, and run an import. Each query logs as `[DB] Executing <name> (step/total)` with the first 300 characters of SQL.
