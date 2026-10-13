# Custom parse rules

Regex rules read dependencies from SQL bodies. Stored procedures get their reads, writes and calls from them; views and functions use them to add to the dependencies the `.dacpac` or catalog reports. The built-in rules are in [`assets/defaultParseRules.yaml`](../assets/defaultParseRules.yaml).

## Setup

1. Run **Data Lineage: Create Parse Rules** from the Command Palette. It copies the built-in YAML to `parseRules.yaml` in the first workspace folder; an existing file is opened, not overwritten.
2. Set `dataLineageViz.parseRulesFile` to that file in VS Code Settings.
3. Edit, add or disable rules. Rules are read on activation and when the setting changes, so after editing reload the window, then reload the model.

The custom file replaces the built-in rules (no merge, no version check), so compare it with the shipped YAML after an upgrade.

## Rule schema

| Field | Required | Purpose |
|---|---|---|
| `name` | yes | Identifier shown in logs. |
| `enabled` | no | `false` skips the rule; default enabled. |
| `priority` | yes | Number; lower runs first. |
| `category` | yes | `preprocessing`, `source`, `target`, `exec` or `external_ref`. |
| `pattern` | yes | JavaScript regex that must not match an empty string. Group 1 is the object reference (for `external_ref`, the path or URL). |
| `flags` | yes | Must include `g`; shipped rules use `g`, `gi` or `giu`. |
| `description` | no | Note. |
| `replacement` | no | Replacement string for `preprocessing` rules; without it the rule does nothing. Editing the built-in `clean_sql` entry has no effect. |
| `kind` | `external_ref` only | Label such as `openrowset`. |

| Category | Effect |
|---|---|
| `source` | Read: edge from the object into the procedure. |
| `target` | Write: edge from the procedure to the object. |
| `exec` | Call to another procedure. |
| `external_ref` | File path or URL, shown when `dataLineageViz.externalRefs.enabled` is on. |
| `preprocessing` | Rewrites the SQL before extraction; adds no edge. |

## Example

This rule reads the table searched by `FREETEXTTABLE` or `CONTAINSTABLE`, which the built-in rules miss. In a double-quoted YAML string every regex backslash is doubled.

```yaml
  - name: extract_fulltext_table
    priority: 30
    category: source
    pattern: "\\b(?:FREETEXTTABLE|CONTAINSTABLE)\\s*\\(\\s*((?:\\[[^\\]]+\\]|\\w+)\\.(?:\\[[^\\]]+\\]|\\w+))"
    flags: gi
```

Use non-capturing groups `(?:...)` except for group 1. Prefer adding rules over editing built-in ones.

## What the rules see

Rules except `external_ref` run on cleaned SQL: comments removed, string literals replaced by `''`, double-quoted identifiers bracketed, whitespace around name periods removed, and built-in rewrites for constructs such as `IS DISTINCT FROM`, DML `TOP` and comma joins. Custom `preprocessing` rules run after these. `external_ref` rules read the raw SQL, ignoring comments.

Only schema-qualified captures that match a loaded object become edges. Temp tables, table variables and CTE names are not lineage nodes.

## Errors and fallback

| Situation | Result |
|---|---|
| Invalid rule | Skipped and logged; a warning gives the count. |
| File unreadable or no valid enabled rule | Built-in rules and a warning. |

## Check it works

1. Open **View → Output → Data Lineage Viz** and set the log level to **Debug**.
2. Reload the model, ideally with only the affected schema.
3. Compare the `[Parse]` entries for the object with its SQL; unresolved captures are listed there.

## Limits

Only tables, views, functions, stored procedures and external objects are loaded. Catalog or `.dacpac` dependencies can still supply an edge the rules miss.

| Construct | Result |
|---|---|
| Schema-less names (`EXEC uspA`, `FROM T`, `db..T`) | Not captured; the parser does not choose a schema. |
| Cross-database `EXEC db.schema.proc` | Call not captured; cross-database reads and writes are. |
| Four-part name `server.db.schema.object` | Read as the cross-database `db.schema.object`; the server is dropped. |
| `OPENDATASOURCE(...)`, `ALTER TABLE ... SWITCH`, `READTEXT` / `WRITETEXT` / `UPDATETEXT` | Nothing captured. |
| `FREETEXTTABLE` / `CONTAINSTABLE`, `VECTOR_SEARCH(TABLE = ...)`, `PREDICT(DATA = ...)` | That table is not read; other tables in the statement are. |
| `DELETE` / `TRUNCATE` | Marked as a delete-only write, not a data source. `DELETE` through a CTE is not marked. |
| Comma-list join after a member with `TABLESAMPLE`, or after `JOIN ... ON` or `APPLY` | Tables after that point are lost. |
| `UPDATE alias` where the alias joins several tables | The write is not captured. |
| `alias.method(...)` on xml, spatial or hierarchyid columns | Read as a two-part name; an edge only if such an object exists. |
| Numbered procedures `EXEC dbo.p;2` | Read as a call to `dbo.p`. |
| JSON and XML functions, SQL Graph syntax, types, variables | Ignored; the tables around them are read as usual. |
| Triggers, synonyms, CLR objects, extended procedures, sequences, user-defined types | Not loaded; references through them are lost. |
| Encrypted or unreadable procedure bodies | Node without edges, with a warning. |

When no rule captures a catalog dependency, it is drawn as `exec` for a procedure, read for a function or view, and read or write for a table depending on the body.

In a clone of this repository, `npm run test:parser` checks expected edges per construct in `tests/cases/parser/exact-edges.yaml`.
