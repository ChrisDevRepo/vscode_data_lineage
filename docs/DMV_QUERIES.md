# DMV queries

Reference for DBAs: the application SQL a database import sends, what it reads and what it returns. The SQL is in [`assets/dmvQueries.yaml`](../assets/dmvQueries.yaml) and can be replaced by a custom file.

## Connection

| Item | Value |
|---|---|
| Authentication | SQL login or Microsoft Entra ID |
| Application intent | `ReadOnly` |
| Encryption | On by default; required for Entra ID |
| Permission | `VIEW DEFINITION` on the database for lineage; `SELECT` on tables for table statistics. Custom queries may need additional permissions. |
| Built-in statements | Catalog queries and metadata functions only; no writes, no temp objects, no user-table reads |
| Timeout | `dataLineageViz.dmvQueryTimeout` per query (default 120 s) |
| Platforms | SQL Server 2016 or later, Azure SQL, Fabric Data Warehouse, Synapse Dedicated SQL Pool |

These guarantees describe the shipped queries. Custom YAML SQL is executed with the connection’s permissions; it is not restricted to `SELECT`. `ReadOnly` application intent is a connection-routing hint, not a permission boundary. Use a login with only the permissions needed for your chosen features.

Table statistics use the same connection settings with different statements; see [`PROFILING_PATTERNS.md`](PROFILING_PATTERNS.md).

## Query execution

| Step | Query | When |
|---|---|---|
| Phase 1 | `schema-preview` | When an import starts, to fill the schema-selection wizard. |
| Platform detection | `platform-info` | After the preview, and again at the start of Phase 2 (10-second limit). |
| Object catalog | `all-objects` | At the start of Phase 2, after platform detection, unfiltered. |
| Phase 2 | `nodes`, `columns`, `constraints`, `dependencies` | After you select schemas. |

Nothing runs in the background. A query is any entry in the YAML; `phase: 1` marks it as not schema-filtered and keeps it out of the Phase 2 sweep, so `platform-info` and `all-objects` carry `phase: 1` although they run at Phase 2 time. Every query without `phase: 1` runs in the Phase 2 sweep, in file order.

If `all-objects` is missing or fails, references into unselected schemas stay unclassified and the import continues.

Table statistics also send `platform-info` when they need server details (edition, version). The extension's import catalog queries come from the YAML; the database name is typed, not listed. Driver connection/session setup is separate from these application queries. Opening a local `.dacpac` does not connect to a database.

### `{{SCHEMAS}}`

`{{SCHEMAS}}` in Phase 2 queries expands to the selected schemas as comma-separated Unicode literals, with embedded quotes doubled, for example `N'dbo', N'Sales'`. The SQL author decides where the filter applies; the SQL is not otherwise rewritten. A Phase 2 query without the placeholder runs verbatim, ignores the schema selection, and logs a warning.

### Query logging

Every executed query is logged to the **Data Lineage Viz** Output channel with the `[DB]` category:

1. Open **View → Output → Data Lineage Viz**.
2. Set the channel log level to **Debug** (gear icon → Set Log Level → Debug). Phase milestones log at Info; per-query SQL logs at Debug.
3. Run an import.
4. Each query logs as `[DB] Executing <name> (step/total) — SQL: <first 300 characters>`, followed by its row count and elapsed time.

The 300-character cap is intentional for log hygiene. The full built-in SQL is in [`assets/dmvQueries.yaml`](../assets/dmvQueries.yaml); custom SQL runs as configured, after `{{SCHEMAS}}` expansion for Phase 2 queries.

### Result contract

Each query must return the columns listed below. Names match case-insensitively; extra columns are ignored; rows are read in the order returned. Only `platform-info` is validated before use; for the other queries a wrong shape can leave the model empty or incomplete, so test a custom result shape before production use.

### `type_code` values

The standard `sys.objects.type` codes; the only deviation is `ET` for external tables (collapsed from `U` with `sys.tables.is_external = 1`). A row with any other code is skipped.

| Code | Object type |
|---|---|
| `U` | Table |
| `V` | View |
| `P` | Stored procedure |
| `FN` | Scalar function |
| `IF` | Inline table-valued function |
| `TF` | Multi-statement table-valued function |
| `ET` | External table (PolyBase, Synapse Dedicated SQL Pool, Fabric) |

**Object filter.** `schema-preview`, `all-objects`, and `nodes` return only user objects of type `U` (table), `V` (view), `P` (procedure), `FN` (scalar function), `IF` (inline table function), `TF` (table function) and `ET` (external table, `sys.tables.is_external = 1`). They exclude `is_ms_shipped = 1` and objects with the extended property `microsoft_database_tools_support`. The unfiltered preview and full catalog also explicitly exclude the `sys` and `INFORMATION_SCHEMA` schemas; `nodes` uses the selected schema list. Other query filters are listed below.

### `schema-preview`

| | |
|---|---|
| Reads | `sys.objects`, `sys.schemas`, `sys.tables`, `sys.extended_properties` |
| Filter | Object filter; all schemas |
| Returns | One row per schema and type (columns below) |
| Used for | Schema names and per-type counts in the schema-selection wizard |

| Column | Type | Description |
|---|---|---|
| `schema_name` | string | Schema name |
| `type_code` | string | Object type code (see `type_code` values) |
| `object_count` | int | Number of objects of that type in the schema |

### `platform-info`

| | |
|---|---|
| Reads | `SERVERPROPERTY('EngineEdition')`, `SERVERPROPERTY('ProductMajorVersion')`, `SERVERPROPERTY('Edition')`; collation of `sys.schemas.name` |
| Returns | One row (columns below) |
| Used for | Platform label, case sensitivity of names, and the sampling method of table statistics |
| Time limit | 10 seconds, or `dataLineageViz.dmvQueryTimeout` if lower |

| Column | Type | Description |
|---|---|---|
| `engine_edition` | int | `SERVERPROPERTY('EngineEdition')`; identifies the platform family |
| `major_version` | int | `SERVERPROPERTY('ProductMajorVersion')`; resolves the SQL Server release year |
| `edition` | string | `SERVERPROPERTY('Edition')`; label when the version is not recognized |
| `identifier_collation` *(optional)* | string/null | Collation of `sys.schemas.name` |
| `identifier_comparison_style` *(optional)* | int/null | `COLLATIONPROPERTY(<collation>, 'ComparisonStyle')`. Names compare case-sensitively only when a collation is returned and the style has the ignore-case bit (1) clear; otherwise case-insensitively. |

Platform label by `engine_edition`:

| Value | Platform |
|---|---|
| 5 | Azure SQL Database |
| 6 | Synapse Dedicated Pool |
| 8 | Azure SQL Managed Instance |
| 9 | Azure SQL Edge |
| 11 | Fabric Data Warehouse |
| 12 | SQL Database in Fabric |
| Other | `SQL Server <year>` from `major_version` (2000–2025); an unknown version falls back to `edition`, then to `Unknown database platform` |

If the query is missing, fails, or returns no row or not the three required columns, the import continues with `Unknown database platform`.

### `all-objects`

| | |
|---|---|
| Reads | `sys.objects`, `sys.schemas`, `sys.tables`, `sys.extended_properties` |
| Filter | Object filter; all schemas; no SQL bodies |
| Returns | One row per object (columns below) |
| Used for | Classifying references into schemas you did not select as known cross-schema objects instead of unresolved, with the catalog's schema casing |

| Column | Type | Description |
|---|---|---|
| `schema_name` | string | Schema name |
| `object_name` | string | Object name |
| `type_code` | string | Object type code |

### `nodes`

| | |
|---|---|
| Reads | `sys.objects`, `sys.schemas`, `sys.tables`, `sys.sql_modules`, `sys.extended_properties` |
| Filter | Object filter; `s.name IN ({{SCHEMAS}})` |
| Returns | One row per object (columns below) |

| Column | Type | Description |
|---|---|---|
| `schema_name` | string | Schema name (`dbo`, `Sales`, …) |
| `object_name` | string | Object name |
| `type_code` | string | Object type code |
| `body_script` | string/null | `sys.sql_modules.definition` for procedures, views and functions; NULL for tables and for bodies the login cannot read |

A repeated schema-qualified object identity is kept once, using the detected identifier case-sensitivity policy.

### `columns`

| | |
|---|---|
| Reads | `sys.columns`, `sys.objects`, `sys.schemas`, `sys.indexes`, `sys.index_columns`, `sys.extended_properties` |
| Filter | Types `U`, `V`, `IF`, `TF`, `ET`; excludes shipped objects and `microsoft_database_tools_support`; `s.name IN ({{SCHEMAS}})` |
| Returns | One row per column, ordered by schema, object and `column_id` (columns below) |
| Used for | Table design preview and column metadata available to optional AI questions; no deterministic column-lineage graph is built |

| Column | Type | Description |
|---|---|---|
| `schema_name` | string | Schema name |
| `table_name` | string | Table, view or function name |
| `ordinal` | int | Column position (1-based) |
| `column_name` | string | Column name |
| `type_name` | string | Data type (`int`, `nvarchar`, …); CLR types such as `hierarchyid`, `geography` and `geometry` use their user-type name |
| `max_length` | int | Maximum length in bytes (-1 = `max`) |
| `precision` | int | Numeric precision |
| `scale` | int | Numeric scale |
| `is_nullable` | bit/bool | Allows NULL |
| `is_identity` | bit/bool | Identity column |
| `is_computed` | bit/bool | Computed column |
| `pk_ordinal` *(optional)* | int/null | Position in the primary key (1-based); NULL for other columns. Drives the `PK` / `PK1` / `PK2` badges; without the column no badges are shown. |

### `constraints`

| | |
|---|---|
| Reads | `sys.foreign_keys`, `sys.foreign_key_columns`, `sys.key_constraints`, `sys.index_columns`, `sys.check_constraints`, `sys.columns`, `sys.objects`, `sys.schemas` |
| Filter | Parent table in `{{SCHEMAS}}`; unique constraints only (`type = 'UQ'`); check constraints defined on a column (`parent_column_id <> 0`) |
| Returns | One row per constraint column, as one `UNION ALL` result distinguished by `constraint_type` (columns below) |
| Used for | `FK`, `UQ` and `CK` annotations in the table design view of tables and external tables |

| Column | Type | Description |
|---|---|---|
| `schema_name` | string | Table schema |
| `table_name` | string | Table name |
| `constraint_type` | string | `FK`, `UQ` or `CK` |
| `constraint_name` | string | Constraint name; a composite constraint repeats it over several rows |
| `column_name` | string | Column name |
| `column_ordinal` | int/null | Key order (`FK`, `UQ` only) |
| `ref_schema` | string/null | Referenced schema (`FK` only); may be an unselected schema |
| `ref_table` | string/null | Referenced table (`FK` only) |
| `ref_column` | string/null | Referenced column (`FK` only) |
| `on_delete` | string/null | Referential action (`FK` only): `NO_ACTION`, `CASCADE`, `SET_NULL`, `SET_DEFAULT` |

The query is optional; without it the design view shows no constraint annotations.

Table-level CHECK constraints (`parent_column_id = 0`) are not returned, even when they reference one column. The query returns column-level CHECK constraints such as those written inline in a column definition. Primary keys come from `columns` (`pk_ordinal`).

### `dependencies`

| | |
|---|---|
| Reads | `sys.sql_expression_dependencies`, `sys.objects`, `sys.schemas`, `sys.columns` |
| Filter | Schema-qualified references only (`referenced_schema_name` and `referenced_entity_name` not NULL); `referenced_class = 1`; referencing object not `is_ms_shipped`; referencing or referenced schema in `{{SCHEMAS}}` |
| Returns | One row per reference (columns below) |
| Used for | Object-level lineage edges, cross-database nodes, and column bindings for function calls |

| Column | Type | Description |
|---|---|---|
| `referencing_schema` | string | Schema of the referencing object |
| `referencing_name` | string | Name of the referencing object |
| `referenced_schema` | string | Schema of the referenced object; a row without it is skipped |
| `referenced_name` | string | Name of the referenced object |
| `referenced_database` *(optional)* | string/null | Database of a cross-database reference; builds a `[db].[schema].[object]` node. Omit if the engine does not expose it. |
| `referenced_server` *(optional)* | string/null | Server of a declared cross-server reference; used only for column bindings |
| `referencing_column` *(optional)* | string/null | Catalog column from `referencing_id` and `referencing_minor_id`; NULL for object-level rows |
| `referenced_column` *(optional)* | string/null | Referenced column from local `referenced_id` and `referenced_minor_id`, when supplied |
| `referenced_type` *(optional)* | string/null | Local `sys.objects.type` code of the referenced object, such as `FN` or `IF`; NULL for cross-database and cross-server references |

The built-in query keeps the optional columns with left joins, so object-level rows are preserved. A custom query that omits them keeps object-level lineage and loses column bindings.

`referencing_column` binds a referenced object, such as a scalar function, to the output column that calls it. A row with `referencing_minor_id = 0` does not say which output column calls the function, so no binding is made; a binding is made only when `referencing_column` matches a loaded column. A binding declares a dependency, not which values contribute to the column; column-level answers come only from the optional AI column trace, which reviews the SQL. Which column dependencies SQL Server records also differs for schema-bound and non-schema-bound objects; see [`sys.sql_expression_dependencies`](https://learn.microsoft.com/sql/relational-databases/system-catalog-views/sys-sql-expression-dependencies-transact-sql).

## Known limitations

| Limitation | Reason |
|------------|--------|
| Dynamic SQL dependencies not captured | `sys.sql_expression_dependencies` only tracks static references. |
| Remote database internals not introspected | Three- or four-part references can surface as virtual cross-database nodes when metadata exposes database/schema/object names, but DMV import remains scoped to the connected database. |
| Unqualified / unresolved references may be excluded | Built-in dependency SQL filters unresolved rows; parser fallback can recover some schema-qualified references from SQL bodies, but default-schema ambiguity is not reliable. |

## Custom queries

### Setup

1. Run **Data Lineage: Create DMV Queries** from the Command Palette (`Ctrl+Shift+P`). It copies the built-in YAML to `dmvQueries.yaml` in the first workspace folder; an existing file is opened, not overwritten.
2. Set `dataLineageViz.dmvQueriesFile` to that file in VS Code Settings (`Ctrl+,`, search "dataLineageViz").
3. Edit the SQL. The file is read again at every import, so an edit applies to the next import.

Table statistics reuse the queries last loaded until the next import or a change of `dataLineageViz.dmvQueriesFile`, so an invalid file warns once rather than on every request.

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
| `name`, `sql` | Required per query; an entry without them is skipped, and the rest of the file stays active. |
| `description` | Optional; informational only. |
| `phase` | `1` or `2`; default `2`. Keep `platform-info` at `phase: 1`. |

Required queries: `schema-preview`, `nodes`, `columns`, `dependencies`. Optional: `all-objects`, `constraints`, `platform-info` (without it, the import records `Unknown database platform` and table statistics report an error).

Without `all-objects`, cross-schema references stay unclassified; without `constraints`, no constraint annotations are shown.

#### What you can customise

- **`WHERE` filters**: restrict to schemas, object types or naming patterns.
- **`JOIN`s**: add joins for extra metadata; extra columns are ignored.
- **Platform-specific syntax**: adapt a query to a vendor dialect, for example Synapse `LABEL` or a Fabric replacement for an unsupported catalog view.

#### What must stay fixed

- **`version`**: must match the shipped file.
- **Required query names**: `schema-preview`, `nodes`, `columns`, `dependencies`.
- **Required column names**: as listed under each query.
- **Column semantics**: `type_code` returns `sys.objects.type` codes, or `ET` for external tables.
- **`{{SCHEMAS}}`** in every Phase 2 query; without it a warning is logged and the selection is ignored.
- **`ORDER BY` of `columns`**: columns are shown in row order.
- **`referenced_database`** in `dependencies`: without it, cross-database references are not recognized.

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
| A required query is missing | A warning lists it when the file loads; the import fails at the step that needs it. |
| A query returns the wrong columns | Extraction may be empty or incomplete; only `platform-info` is validated, and an unusable result records `Unknown database platform`. |
| The built-in file itself cannot be read | An error is logged and the import shows an error. |

## Check it works

Open **View → Output → Data Lineage Viz**, set the log level to **Debug**, and run an import; see [Query logging](#query-logging).

## Reference

- Built-in YAML: [`assets/dmvQueries.yaml`](../assets/dmvQueries.yaml)
- Microsoft DMV catalogue: <https://learn.microsoft.com/sql/relational-databases/system-dynamic-management-views/system-dynamic-management-views>
