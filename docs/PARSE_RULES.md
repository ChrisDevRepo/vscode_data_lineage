# Parse rules

Regex rules read dependencies from SQL bodies. Stored procedures get their reads, writes and calls from them; views and functions use them to add to the dependencies the `.dacpac` or catalog reports. Tables have no SQL body to parse.

The built-in rules are in [`assets/defaultParseRules.yaml`](../assets/defaultParseRules.yaml). That file is the source of truth for rule names and patterns.

## Setup

1. Run **Data Lineage: Create Parse Rules** from the Command Palette. It copies the built-in YAML to `parseRules.yaml` in the first workspace folder; an existing file is opened, not overwritten.
2. Set `dataLineageViz.parseRulesFile` to that file in VS Code Settings.
3. Edit, add or disable rules.
4. Reload the window, then reload the model. Rules are read on activation and when the setting changes.

The custom file replaces the built-in rules; there is no merge and no version check. Compare it with the shipped YAML after an upgrade.

## Rule schema

Each entry in `rules:`:

| Field | Required | Purpose |
|---|---|---|
| `name` | Yes | Identifier shown in logs. |
| `enabled` | No | `false` skips the rule. Default: enabled. |
| `priority` | Yes | Number. Lower runs first. |
| `category` | Yes | `preprocessing`, `source`, `target`, `exec` or `external_ref`. |
| `pattern` | Yes | Regex (JavaScript syntax) that must not match an empty string. Group 1 is the object reference; for `external_ref`, the path or URL. |
| `flags` | Yes | Must include `g`. Usually `gi`. |
| `description` | No | Note shown in logs and errors. |
| `replacement` | `preprocessing` only | Replacement string. The built-in `clean_sql` entry only documents the built-in cleansing; editing it has no effect. |
| `kind` | `external_ref` only | Label such as `openrowset`, `copy_from` or `bulk_from`. A rule without it is skipped. |

### Categories

| Category | Edge |
|---|---|
| `source` | Read: object → procedure. |
| `target` | Write: procedure → object. |
| `exec` | Call: procedure → called procedure. |
| `external_ref` | File path or URL, shown as an external node when `dataLineageViz.externalRefs.enabled` is on. |
| `preprocessing` | None. Rewrites the SQL after the built-in cleansing and before extraction. |

### Example

This rule reads the table searched by `FREETEXTTABLE` or `CONTAINSTABLE`, which the built-in rules miss. In a double-quoted YAML string every regex backslash is doubled.

```yaml
  - name: extract_fulltext_table
    priority: 30
    category: source
    pattern: "\\b(?:FREETEXTTABLE|CONTAINSTABLE)\\s*\\(\\s*((?:\\[[^\\]]+\\]|\\w+)\\.(?:\\[[^\\]]+\\]|\\w+))"
    flags: gi
```

Guidance:

- Add rules rather than editing built-in ones, and give them priorities after the shipped ones unless an earlier pass is intended.
- Use non-capturing groups `(?:...)` except for group 1.
- For dialect-specific syntax (Synapse `LABEL`, Fabric), add a sibling rule guarded by the dialect's keyword instead of changing a generic rule.

## How SQL is read

Before the rules run, the SQL is cleaned:

- Comments are removed and string literals are replaced by `''`. Bracketed identifiers and escaped brackets are kept.
- Whitespace around the period of a multipart name is removed (`dbo . T` reads as `dbo.T`).
- The `FROM` of `IS [NOT] DISTINCT FROM` and of `TRIM(... FROM ...)` is read as an operand separator, not a `FROM` clause.
- `TOP (expression) [PERCENT]` is taken out of `INSERT`, `UPDATE` and `MERGE`, so the target follows the keyword.
- The column list and `WITH` options of `CREATE [EXTERNAL] TABLE ... AS SELECT` are removed, so the name stands directly before `AS`.

Then custom `preprocessing` rules run, the other rules run in priority order, and captures are resolved against the loaded objects. `external_ref` rules read the raw SQL, because paths and URLs occur in string literals.

The shipped rules cover `FROM` / `JOIN` / `APPLY` sources, DML and `CREATE TABLE AS SELECT` targets, procedure calls, and file references from `OPENROWSET`, `COPY INTO` and `BULK INSERT`.

Temp tables (`#local`, `##global`), table variables (`@name`), CTE names and unqualified captures are not lineage nodes. Flow through a shared global temp table therefore does not connect procedures in the graph.

### `UPDATE alias`

`extract_update_alias_target` only anchors `UPDATE alias SET`. Its match must contain that text and must not consume the statement; capture group 1 is the alias.

- The alias binds to the single top-level `FROM`/`JOIN` table of the same statement, or to a top-level `FROM`/`JOIN` derived table whose query names one table, however long the `SET` list is.
- A CTE name used as the `UPDATE` target, or as a `FROM`/`JOIN` table of that `UPDATE`, resolves to the one table its query names: exactly one `FROM` at the query's own level holding one table reference (a derived table there is read the same way), followed through earlier CTEs of the same `WITH` list.
- A join list names one table when exactly one member is a table reference and every other member is a derived table that cannot be written through (`DISTINCT`, `GROUP BY` or a set operator at its own level).
- The rewrite applies only to the `UPDATE` that directly follows the `WITH` list.
- A CTE that joins two table references, a table function or a writable derived table, uses `APPLY` or a set operator, or names no single table leaves the write unresolved. A comma list is read as a join list.
- An `INSERT` or `MERGE` into a CTE yields no write target.

## Known boundaries

These constructs can lose references in SQL-body parsing, or are left unresolved by design because only syntax and identifier normalisation are applied. Native DACPAC or DMV metadata may still supply dependencies.

| Construct | Behaviour | Where it applies |
|---|---|---|
| `FREETEXTTABLE(dbo.T, ...)` / `CONTAINSTABLE(dbo.T, ...)` | The table is not captured. | Where full-text table functions are available |
| `OPENDATASOURCE(...)...` | Nothing is captured, including the four-part table name. | Where the SQL dialect supports this syntax |
| `ALTER TABLE dbo.A SWITCH PARTITION n TO dbo.B` | Neither table is captured. | Partition switching is DDL, not DML; no edge is modelled either way |
| ANSI-89 comma list whose member is followed by `TABLESAMPLE`, or that continues with a comma after a `JOIN ... ON` condition or an `APPLY` | The list ends at that member, so tables after it are lost (table-variable members are not tables). | Legacy bodies on any platform |
| `DELETE` / `TRUNCATE TABLE` | No data write is captured; the table named after `FROM` is read as a source. When the catalog or `.dacpac` lists the dependency, the table is also marked as a delete-only write, with or without `FROM`. | By design: a delete is not a data flow into the table |
| `WITH d AS (SELECT ... FROM dbo.T) DELETE FROM d` | `dbo.T` is read as a source; the delete-only write is not marked because the statement names only the CTE. | Any platform with CTEs |
| Schema-less `EXEC uspA`, `FROM T`, `db..T` | Not captured; only schema-qualified names resolve. | By design: the parser does not choose a schema |
| `EXEC db.schema.proc` / `EXEC server.db.schema.proc` | The cross-database call is not captured; cross-database reads and writes are. | SQL Server, Azure SQL Managed Instance |
| `alias.method(...)` on an xml, spatial or hierarchyid column, such as `x.value(...)` or `g.STDistance(...)` | Captured as a two-part reference that becomes an edge only if the catalog holds that schema-qualified object. | By design: the text does not distinguish `column.method()` from `schema.function()` |
| `UPDATE alias SET` where the alias names a derived table or CTE that joins more than one writable member (two tables, a table function, a derived table without `DISTINCT`, `GROUP BY` or a set operator), uses `APPLY` or a set operator, or names no single table, or is declared inside a parenthesised joined table | The write is not captured; the parser does not choose among the tables. | Any platform |
| A body with an unbalanced parenthesis | The `CREATE TABLE AS SELECT` pass and the `UPDATE alias` binding stop at the open parenthesis, so a target or aliased write after it is not captured. | Malformed text only: a body the database compiled always balances |

## Out of scope

Lineage covers five object kinds: table, view, function, stored procedure and external object (external table, external file, cross-database reference). Every other kind is not loaded: no node, no edge, no warning. Built-in and function-style features, types, column methods and variables are not database objects and are ignored. Supported platforms are SQL Server, Azure SQL, Fabric Data Warehouse and Synapse Dedicated SQL Pool.

| Item | Behaviour | Reason |
|---|---|---|
| Triggers, DML and DDL | Not loaded. The catalog query lists only the types `U`, `V`, `P`, `FN`, `IF`, `TF`, `ET`, and the DACPAC reader tracks only table, view, procedure, function and external-table elements. | Not an object kind of the lineage |
| Synonyms | Not loaded. A reference through a synonym is captured as a two-part name, no catalog object carries it, and it resolves to nothing. | Not an object kind of the lineage |
| CLR procedures, functions and aggregates; extended stored procedures | Not loaded from a live database; the types `PC`, `FS`, `FT`, `AF`, `X` are outside the catalog query. | Not an object kind of the lineage |
| Numbered procedures `proc;2` | The group number is dropped: `EXEC dbo.p;2` reads as a call to `dbo.p`; the groups are not told apart. | Not an object kind of the lineage |
| Sequences, user-defined types, table types, XML schema collections, rules, defaults | Not loaded. `NEXT VALUE FOR dbo.Seq` and `DECLARE @t dbo.TableType` add no edge. The `dependencies` query keeps only `referenced_class = 1`, so a dependency row on a type or XML schema collection is filtered. | Not an object kind of the lineage |
| A stored procedure whose definition is not readable (`WITH ENCRYPTION`, or no `VIEW DEFINITION` permission) | Loaded as a node without edges and marked with a warning. Its catalog dependencies carry no read or write direction without the body, so none is drawn. | No body to parse |
| `VECTOR_SEARCH`, `VECTOR_DISTANCE`, the `vector` type | Ignored. The other tables of the statement are read normally, but the table named in `VECTOR_SEARCH(TABLE = ...)` is not read. | Functions and a type, not objects |
| `OPENJSON`, `JSON_VALUE`, `FOR JSON`, `FOR XML`, `OPENXML`, `STRING_SPLIT` | Ignored; the tables around them are read normally. xml methods follow the `alias.method(...)` row above. | Functions and clauses, not objects |
| SQL Graph: `MATCH`, `SHORTEST_PATH`, `$node_id`, `$from_id` and the other node and edge pseudo-columns | The graph semantics are not interpreted. Node and edge tables are ordinary tables, and their `FROM` references are read as such. A `FOR PATH` member of a comma list falls under the comma-list boundary. | Graph semantics are not lineage |
| `PREDICT(MODEL = ..., DATA = dbo.T AS d)` | The table after `DATA =` is not read; a table named in a subquery inside the call is. | A function, not an object |
| `READTEXT`, `WRITETEXT`, `UPDATETEXT` | The `dbo.T.col` operand names no table. | Deprecated statements |
| Four-part name `server.db.schema.object` | The server part is dropped; the reference is the cross-database `db.schema.object`, in a read or a write. The `EXEC` form is in the table above. | The remote server is not introspected |
| Synapse serverless SQL pool syntax, such as `OPENROWSET(...) AS r` with `r.filepath()` | Not covered. | Not a supported platform |
| Babelfish syntax, such as `pg_catalog.varchar` | Not covered. | Not a supported platform |

## Metadata fallback direction

When the rules miss a dependency that the `.dacpac` or catalog does report, the edge is still drawn, with its direction inferred from the referenced object's type:

| Referenced type | Edge | Rationale |
|---|---|---|
| Procedure | Call | A procedure referencing another procedure through metadata almost always `EXEC`s it. |
| Function | Read | A procedure referencing a function through metadata almost always reads from it. |
| Table / external table | Read or write | The procedure body is checked for a matching write verb; otherwise the reference is a read. |
| View | Read | Metadata-only view references are treated as reads. |

The fallback supplements the rules; it does not make static parsing complete. Unresolved schema-qualified references are listed in Debug diagnostics and left out of the graph.

## Errors and fallback

| Situation | Result |
|---|---|
| Invalid rule | Skipped and logged; a warning gives the count. |
| File unreadable or no valid enabled rule | Built-in rules and a warning. |

## Check a rule change

1. Open **View → Output → Data Lineage Viz** and set the log level to **Debug**.
2. Reload the model, ideally with only the affected schema selected.
3. Compare the `[Parse]` entries for the object with its SQL. Dropped references are listed there.

In a clone of this repository, `npm run test:parser` checks the expected edges per construct.

T-SQL reference: <https://learn.microsoft.com/sql/t-sql/language-reference>
