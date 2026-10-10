# Custom Parse Rules

SQL-body dependencies are extracted by a multi-pass regex engine driven by metadata in [`assets/defaultParseRules.yaml`](../assets/defaultParseRules.yaml). Stored procedures use it for source, target, and execution direction; views and functions use it to supplement native `.dacpac` XML or DMV dependencies. Tables have no SQL body to parse. This document is the reference for editing or extending that YAML.

## Setup

1. Command Palette → **Data Lineage: Create Parse Rules** copies the built-in YAML into your workspace.
2. Set `dataLineageViz.parseRulesFile` to the path of the copy (search "dataLineageViz" in VS Code Settings).
3. Edit, add, or disable rules. Invalid entries are skipped and logged; the extension shows a warning whenever any rule is skipped, not only when none remain valid. A custom file with no valid enabled rule falls back to the built-in rules, with a warning.
4. Reload the model. Run `npm run test:parser` and review the resulting dependency edges against the affected SQL.

## Parsing pipeline

The parser removes comments and neutralises string literals, removes
whitespace around the period of a multipart name (`dbo . T` reads as `dbo.T`),
reads the `FROM` of `IS [NOT] DISTINCT FROM` and of `TRIM(... FROM ...)` as an
operand separator instead of a FROM clause, takes `TOP (expression) [PERCENT]`
out of `INSERT`, `UPDATE` and `MERGE` so the target follows the keyword,
removes the column list and `WITH` options of `CREATE [EXTERNAL] TABLE ... AS SELECT`
so the name stands directly before `AS`,
applies YAML rules in priority order, normalises captures, and resolves
references against the loaded catalog. Identifiers round-trip through their own
delimiter escapes (`]]` in brackets, `""` in double quotes); canonical bracket
IDs preserve literal delimiters under both CI and CS comparison.
Before custom preprocessing, the parser also captures physical mutation facts
for catalog-backed direction. DELETE/TRUNCATE remain separate from data-producing
targets. File and URL rules inspect raw SQL because their values occur in string
literals; matches inside comments are excluded.

## Rule schema

Each entry in `rules:` carries:

| Field | Required | Purpose |
|-------|----------|---------|
| `name` | ✓ | Stable identifier for logs and tests. |
| `enabled` |  | Set `false` to skip the rule; defaults to enabled. |
| `priority` | ✓ | Lower runs first. Choose custom priorities after the shipped rules listed in the built-in YAML. |
| `category` | ✓ | One of `preprocessing` \| `source` \| `target` \| `exec` \| `external_ref`. Drives edge direction. |
| `pattern` | ✓ | JavaScript regex that must not match an empty string. **Capture group 1** must be the object reference (or, for `external_ref`, the URL / path inside quotes). |
| `flags` | ✓ | Regex flags; **must include `g`**. `gi` is the usual choice. |
| `description` |  | Human-readable hint shown in logs and errors. |
| `replacement` | preprocessing only | Replacement string applied by a custom preprocessing pass. The built-in `clean_sql` entry documents the built-in cleansing pipeline; editing it has no effect. |
| `kind` | ✓ for `external_ref` | Non-empty label (e.g. `openrowset`, `copy_from`, `bulk_from`); a rule without it is skipped. |

Categories drive edge direction:

- `source` — adds an inbound edge (referenced object → focus SP).
- `target` — adds an outbound edge (focus SP → referenced object).
- `exec` — adds an outbound execution edge (`EXEC SomeProc`).
- `external_ref` — captures non-catalog references (file paths, URLs); rendered as virtual external-ref nodes when `dataLineageViz.externalRefs.enabled = true`.
- `preprocessing` — applied after the built-in cleansing passes and before extraction; not an extractor.

## Built-in coverage

The shipped rules cover common `FROM` / `JOIN` / `APPLY` sources, DML and
CTAS-style targets, procedure calls, and file references from `OPENROWSET`,
`COPY INTO`, and `BULK INSERT`. Read
[`assets/defaultParseRules.yaml`](../assets/defaultParseRules.yaml) for the
current names and regex bodies; that file is the source of truth.
`tests/unit/parser/tsql-coverage-matrix.test.ts` states the expected reads,
writes and calls for each supported T-SQL construct.

`extract_update_alias_target` only anchors `UPDATE alias SET`; its
match must contain that text and must not consume the statement, and capture
group 1 is the alias. The parser
binds the alias to the single top-level `FROM`/`JOIN` table of the same
statement, or to a top-level `FROM`/`JOIN` derived table whose query names one
table, however long the `SET` list is. A CTE name used as an
`UPDATE` target, or as a `FROM`/`JOIN` table of that `UPDATE`, resolves before the rules run to the one table its
query names: exactly one `FROM` at the query's own level holding one table reference (a derived
table there is read the same way), followed through earlier CTEs of the same `WITH` list. A join
list names one table when exactly one member is a table reference and every other member is a
derived table that cannot be written through (`DISTINCT`, `GROUP BY` or a set operator at its own
level). The rewrite applies only to the `UPDATE` that directly follows the `WITH` list. A CTE
that joins two table references, a table function or a writable derived table, uses `APPLY` or a
set operator, or names no single table leaves the write unresolved; a comma list is read as a join
list. An
`INSERT` or `MERGE` into a CTE yields no write target.

Temp tables (`#local`, `##global`), table variables (`@name`), CTE names,
and unqualified captures are not lineage nodes. Flow through a shared global
temp table therefore does not connect procedures in the graph.

### Known boundaries

These constructs can lose references in SQL-body parsing, or are left
unresolved by design because only syntax and identifier normalisation are
applied. Native DACPAC or DMV metadata may still supply dependencies.

| Construct | Behaviour | Where it applies |
|---|---|---|
| `FREETEXTTABLE(dbo.T, ...)` / `CONTAINSTABLE(dbo.T, ...)` | the table is not captured | Where full-text table functions are available |
| `OPENDATASOURCE(...)...` | nothing is captured, including the four-part table name | Where the SQL dialect supports this syntax |
| `ALTER TABLE dbo.A SWITCH PARTITION n TO dbo.B` | neither table is captured | partition switching is DDL, not DML; no edge is modelled either way |
| ANSI-89 comma list whose member is followed by `TABLESAMPLE`, or that continues with a comma after a `JOIN ... ON` condition or an `APPLY` | the list ends at that member, so tables after it are lost (table-variable members are not tables) | legacy bodies on any platform |
| `DELETE` / `TRUNCATE TABLE` | no data-producing target is captured; parser mutation facts mark catalog-backed delete-only writes | by design: removal does not supply column values |
| `WITH d AS (SELECT ... FROM dbo.T) DELETE FROM d` | `dbo.T` is read as a source; the delete-only write is not marked because the statement names only the CTE | any platform with CTEs |
| Schema-less `EXEC uspA`, `FROM T`, `db..T` | not captured; only schema-qualified names resolve | by design: the parser does not choose a schema |
| `EXEC db.schema.proc` / `EXEC server.db.schema.proc` | the cross-database call is not captured; the parse result has cross-database reads and writes but no cross-database call | SQL Server, Azure SQL Managed Instance |
| `alias.method(...)` on an xml, spatial or hierarchyid column, such as `x.value(...)` or `g.STDistance(...)` | captured as a two-part reference that becomes an edge only if the catalog holds that schema-qualified object | by design: the text does not distinguish `column.method()` from `schema.function()` |
| `UPDATE alias SET` where the alias names a derived table or CTE that joins more than one writable member (two tables, a table function, a derived table without `DISTINCT`, `GROUP BY` or a set operator), uses `APPLY` or a set operator, or names no single table, or is declared inside a parenthesised joined table | the write is not captured; the parser does not choose among the tables | any platform |
| A body with an unbalanced parenthesis | the CTAS pass and the `UPDATE alias` binding stop at the open parenthesis, so a CTAS target or aliased write after it is not captured | malformed text only: a body the database compiled always balances |

### Out of scope

Lineage covers five object kinds: table, view, function, stored procedure and
external object (external table, external file, cross-database reference). Every
other kind is not loaded: no node, no edge, no warning. Built-in and
function-style features, types, column methods and variables are not database
objects and are ignored. Supported platforms are SQL Server, Azure SQL, Fabric
Data Warehouse and Synapse Dedicated SQL Pool.

| Item | Behaviour | Reason |
|---|---|---|
| Triggers, DML and DDL | not loaded; the catalog query lists only the types `U`, `V`, `P`, `FN`, `IF`, `TF`, `ET` and the DACPAC reader tracks only table, view, procedure, function and external-table elements | not an object kind of the lineage |
| Synonyms | not loaded; a reference through a synonym is captured as a two-part name, no catalog object carries it, and it resolves to nothing | not an object kind of the lineage |
| CLR procedures, functions and aggregates; extended stored procedures | not loaded from a live database; the types `PC`, `FS`, `FT`, `AF`, `X` are outside the catalog query | not an object kind of the lineage |
| Numbered procedures `proc;2` | the group number is dropped: `EXEC dbo.p;2` reads as a call to `dbo.p`; the groups are not told apart | not an object kind of the lineage |
| Sequences, user-defined types, table types, XML schema collections, rules, defaults | not loaded; `NEXT VALUE FOR dbo.Seq` and `DECLARE @t dbo.TableType` add no edge; the `dependencies` query keeps only `referenced_class = 1`, so a dependency row on a type or XML schema collection is filtered | not an object kind of the lineage |
| A stored procedure whose definition is not readable (`WITH ENCRYPTION`, or no `VIEW DEFINITION` permission) | loaded as a node without edges and marked with a warning; its catalog dependencies carry no read or write direction without the body, so none is drawn | no body to parse |
| `VECTOR_SEARCH`, `VECTOR_DISTANCE`, the `vector` type | ignored; the other tables of the statement are read normally, but the table named in `VECTOR_SEARCH(TABLE = ...)` is not read | functions and a type, not objects |
| `OPENJSON`, `JSON_VALUE`, `FOR JSON`, `FOR XML`, `OPENXML`, `STRING_SPLIT` | ignored; the tables around them are read normally; xml methods follow the `alias.method(...)` row above | functions and clauses, not objects |
| SQL Graph: `MATCH`, `SHORTEST_PATH`, `$node_id`, `$from_id` and the other node and edge pseudo-columns | the graph semantics are not interpreted; node and edge tables are ordinary tables, and their `FROM` references are read as such; a `FOR PATH` member of a comma list falls under the comma-list boundary | graph semantics are not lineage |
| `PREDICT(MODEL = ..., DATA = dbo.T AS d)` | the table after `DATA =` is not read; a table named in a subquery inside the call is | a function, not an object |
| `READTEXT`, `WRITETEXT`, `UPDATETEXT` | the `dbo.T.col` operand names no table | deprecated statements |
| Four-part name `server.db.schema.object` | the server part is dropped; the reference is the cross-database `db.schema.object`, in a read or a write; the `EXEC` form is in the table above | the remote server is not introspected |
| Synapse serverless SQL pool syntax, such as `OPENROWSET(...) AS r` with `r.filepath()` | not covered | not a supported platform |
| Babelfish syntax, such as `pg_catalog.varchar` | not covered | not a supported platform |

## Catalog dependency direction

The DACPAC XML or DMV catalog can supply dependencies absent from the configured
captures. The graph builder binds those references to catalog objects; SQL
classification comes only from the parser, with no second scan of the body.

| Referenced type | Inferred edge | Rationale |
|-----------------|---------------|-----------|
| `procedure` | exec | An SP referencing another SP via metadata almost always `EXEC`s it. |
| `function` | source | An SP referencing a function via metadata almost always reads from it. |
| `table` / `external table` | source or target | Matching parser mutation facts determine write or delete-only direction; otherwise the reference is a read. |
| `view` | source | Metadata-only view references are treated as reads. |

Catalog binding does not make static parsing complete. Unresolved schema-qualified references are included in DEBUG
diagnostics and omitted from the graph.

## How to verify a rule change

Run the maintained parser subset:

```bash
npm run test:parser
```

Review affected SQL cases and expected edge directions as well as the test result.

For ad-hoc verification:

1. Open the VS Code Output panel → select **Data Lineage Viz**.
2. Set the channel log level to **Debug** (gear icon → Set Log Level → Debug).
3. Reload your model.
4. Review `[Parse]` entries for the affected object and compare the resolved
   dependencies with the expected SQL direction.

When working on a single SP, point the wizard at one schema, narrow the model, and read the parsed output for that SP only — fewer log lines, faster feedback.

## Customisation guidance

- Add new patterns rather than modifying built-ins. Rule precedence is by
  `priority`; inspect the built-in YAML and place custom rules after the shipped
  priorities unless an earlier pass is intentional.
- Use non-capturing groups (`(?:...)`) except for the object reference in group 1.
- For dialect-specific syntax (Synapse `LABEL`, Fabric quirks) prefer adding a sibling rule guarded by the dialect's keyword rather than editing a generic rule's regex.
- If a captured identifier does not resolve against the catalog, the parser
  omits the ordinary catalog edge; use DEBUG logging to review dropped
  references. `external_ref` rules follow their virtual-node contract instead.

## Reference

- Built-in YAML: [`assets/defaultParseRules.yaml`](../assets/defaultParseRules.yaml)
- Engine: [`src/engine/sqlBodyParser.ts`](../src/engine/sqlBodyParser.ts)
- Microsoft T-SQL reference: <https://learn.microsoft.com/sql/t-sql/language-reference>
