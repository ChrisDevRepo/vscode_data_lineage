# Custom Parse Rules

Dependencies in SQL bodies are extracted by regex rules defined in [`assets/defaultParseRules.yaml`](../assets/defaultParseRules.yaml). Stored procedures use them for source, target and execution direction; for views and functions only the source references are used. Tables have no SQL body. This document is the reference for editing or extending that YAML.

## Setup

1. Command Palette → **Data Lineage: Create Parse Rules** copies the built-in YAML to `parseRules.yaml` in the workspace root. An existing `parseRules.yaml` is opened instead.
2. Set `dataLineageViz.parseRulesFile` to that path (search "dataLineageViz" in VS Code Settings). A relative path is resolved against the first workspace folder and saved back as an absolute path.
3. Edit, add, or disable rules. Invalid entries are skipped and logged; the extension shows a warning whenever any rule is skipped, not only when none remain valid.
4. Reload the window after editing the file; rules are read at activation and when the setting changes. Then reload the data source and review the resulting dependency edges against the affected SQL.

## Rule schema

Each entry in `rules:` carries:

| Field | Required | Purpose |
|-------|----------|---------|
| `name` | ✓ | Rule identifier; appears in the debug log. |
| `enabled` |  | Set `false` to skip the rule; defaults to enabled. |
| `priority` | ✓ | Lower runs first. Choose custom priorities after the shipped rules listed in the built-in YAML. |
| `category` | ✓ | One of `preprocessing` \| `source` \| `target` \| `exec` \| `external_ref`. Drives edge direction. |
| `pattern` | ✓ | JavaScript regex that must not match an empty string. **Capture group 1** must be the object reference (or, for `external_ref`, the URL / path inside quotes). |
| `flags` | ✓ | Regex flags; **must include `g`**. `gi` is the usual choice. |
| `description` |  | Free-text note; the parser does not use it. |
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
current names and regex bodies.

Temp tables (`#local`, `##global`), table variables (`@name`), CTE names,
and unqualified captures are not lineage nodes. Flow through a shared global
temp table therefore does not connect procedures in the graph.

### Not covered

These are the cases most often met. Native `.dacpac` or DMV metadata may still
supply dependencies.

| Case | Behaviour |
|---|---|
| Dynamic SQL (`EXEC(@sql)`, `sp_executesql`) | names built inside strings are not read |
| Schema-less `EXEC uspA`, `FROM T`, `db..T` | not captured; only schema-qualified names resolve |
| `EXEC db.schema.proc` | the cross-database call is not captured; cross-database reads and writes are |
| `DELETE` / `TRUNCATE TABLE` | no write is captured by the rules; in `DELETE ... FROM dbo.T` the table is read as a source |
| Triggers, synonyms, sequences, user-defined types | not loaded; a reference through a synonym resolves to nothing |
| A stored procedure whose definition is not readable (`WITH ENCRYPTION`, or no `VIEW DEFINITION` permission) | loaded as a node and marked with a warning; its own dependencies are not read |

## How to verify a rule change

1. Open the VS Code Output panel → select **Data Lineage Viz**.
2. Set the channel log level to **Debug** (gear icon → Set Log Level → Debug).
3. Reload the window after editing the rules, then load the model again.
4. Review the `Parsed <schema.name>` entries for the affected object and compare the resolved
   dependencies with the expected SQL direction. `Unrelated:` lines list references that did not resolve to a loaded object.

## Customisation guidance

- Add new patterns rather than modifying built-ins. Rules run in `priority`
  order; place custom rules after the shipped priorities unless an earlier pass
  is intentional.
- Capture group 1 must be the object reference; use non-capturing groups (`(?:...)`) for the rest.
- If a captured identifier does not resolve against the catalog, the parser
  omits the ordinary catalog edge; use DEBUG logging to review dropped
  references. `external_ref` captures are not looked up in the catalog.

## Reference

- Built-in YAML: [`assets/defaultParseRules.yaml`](../assets/defaultParseRules.yaml)
- Microsoft T-SQL reference: <https://learn.microsoft.com/sql/t-sql/language-reference>
