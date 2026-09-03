# Custom Parse Rules

SQL-body dependencies are extracted by a multi-pass regex engine driven by metadata in [`assets/defaultParseRules.yaml`](../assets/defaultParseRules.yaml). Stored procedures use it for source, target, and execution direction; views and functions use it to supplement native `.dacpac` XML or DMV dependencies. Tables have no SQL body to parse. This document is the reference for editing or extending that YAML.

## Setup

1. Command Palette → **Data Lineage: Create Parse Rules** copies the built-in YAML into your workspace.
2. Set `dataLineageViz.parseRulesFile` to the path of the copy (search "dataLineageViz" in VS Code Settings).
3. Edit, add, or disable rules. Invalid entries are skipped and logged; the extension shows a warning whenever any rule is skipped, not only when none remain valid.
4. Reload the model. Run `npm run test:parser` and review the resulting dependency edges against the affected SQL before merging.

## Parsing pipeline

The parser neutralises non-code text, applies YAML rules in priority order,
normalises captures, and resolves ordinary references against the loaded
catalog before creating graph edges. Block-comment removal treats a bracketed
identifier as opaque the same way it already treats a quoted string: an
apostrophe or a `/*` inside `[Bob's Table]` cannot open a string literal or a
comment, and a doubled `]]` inside the brackets reads as an escaped `]`, not
the end of the name — so a commented-out object placed after such a name is
still removed and does not surface as a dependency. File and URL rules can
inspect raw SQL because their values live in string literals. See
[`src/engine/sqlBodyParser.ts`](../src/engine/sqlBodyParser.ts) for the current
preprocessing implementation.

## Rule schema

Each entry in `rules:` carries:

| Field | Required | Purpose |
|-------|----------|---------|
| `name` | ✓ | Stable identifier for logs and tests. |
| `enabled` |  | Opt-out switch: only `enabled: false` skips the rule. Omitting it — or giving it any other value — runs the rule, and validation never inspects the field. |
| `priority` |  ✓ | Lower runs first. Choose custom priorities after the shipped rules listed in the built-in YAML. |
| `category` | ✓ | One of `preprocessing` \| `source` \| `target` \| `exec` \| `external_ref`. Drives edge direction. |
| `pattern` | ✓ | JavaScript regex. **Capture group 1** must be the object reference (or, for `external_ref`, the URL / path inside quotes). |
| `flags` | ✓ | Regex flags. **Must include `g`** — a rule whose flags omit it is rejected by name, because a non-global pattern either hangs the scan or silently under-matches. `gi` is the usual choice. |
| `description` |  | Human-readable hint shown in logs and errors. |
| `replacement` | preprocessing only | Replacement string when the rule is a custom preprocessing pass. |
| `kind` | external_ref only | Free-text label (e.g. `openrowset`, `copy_from`, `bulk_from`). |

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

Not supported: temp tables (`#local`, `##global`), table variables (`@name`), and CTE names are
never lineage nodes — a captured name starting with `#` or `@`, or carrying no schema
qualifier, is discarded before edge extraction. A data flow that crosses procedures through a global temp table (one procedure
writes `##t`, another reads it) therefore produces no edge between the two procedures, and the
AI column trace ends at that boundary.

### Known boundaries

Constructs a regex set cannot reach, or reaches only partially. Each is a silent under-capture —
the object is a real dependency and no edge is emitted — and each is left as is because the
construct is rare on the supported platforms. Scoped by platform where that matters.

| Construct | Behaviour | Where it applies |
|---|---|---|
| `FREETEXTTABLE(dbo.T, col, 'terms')` | the table is not captured | SQL Server, Azure SQL. Full-text search does not exist on Synapse dedicated or Fabric Warehouse |
| `OPENDATASOURCE(...)...` | nothing is captured, including the four-part table name | SQL Server, Azure SQL only |
| `ALTER TABLE dbo.A SWITCH PARTITION n TO dbo.B` | neither table is captured | partition switching is DDL, not DML; no edge is modelled either way |
| ANSI-89 comma list followed by `UNION`, `OPTION`, `PIVOT` or `TABLESAMPLE`, or containing a table variable | the whole list fails to normalise, so tables after the first are lost | legacy bodies on any platform |
| `]]` inside a delimited identifier (`[My]]Table]`) | the name-capture pass truncates the identifier at the first `]`, so the resolved reference is wrong even though comment/string neutralization reads the same name correctly | any platform; Microsoft documents the escape as an oddity |

`CONTAINSTABLE`, `WITH XMLNAMESPACES`, and `CROSS APPLY x.Doc.nodes(...)` were checked and are
handled correctly — the base table is captured and no phantom reference is produced.

## XML fallback direction

When the regex set misses a dependency that the dacpac XML or DMV catalog *does* report, the extension still emits the edge — direction inferred from the referenced object's type:

| Referenced type | Inferred edge | Rationale |
|-----------------|---------------|-----------|
| `procedure` | exec | An SP referencing another SP via metadata almost always `EXEC`s it. |
| `function` | source | An SP referencing a function via metadata almost always reads from it. |
| `table` / `external table` | source or target | The stored-procedure body is checked for a matching write verb; otherwise the reference is treated as a read. |
| `view` | source | Metadata-only view references are treated as reads. |

Metadata fallback supplements the YAML, but it does not make static parsing
complete. Unresolved schema-qualified references are included in DEBUG
diagnostics and omitted from the graph.

## How to verify a rule change

Run the maintained parser subset:

```bash
npm run test:parser
```

There is no snapshot test script. A green parser run does not prove that every
dependency edge is unchanged, so review affected SQL cases and their expected
edge direction explicitly.

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
- The capture group 1 contract is non-negotiable. If your regex needs more than one group, use non-capturing groups (`(?:...)`) for everything except the object reference.
- For dialect-specific syntax (Synapse `LABEL`, Fabric quirks) prefer adding a sibling rule guarded by the dialect's keyword rather than editing a generic rule's regex.
- If a captured identifier does not resolve against the catalog, the parser
  omits the ordinary catalog edge; use DEBUG logging to review dropped
  references. `external_ref` rules follow their virtual-node contract instead.

## Reference

- Built-in YAML: [`assets/defaultParseRules.yaml`](../assets/defaultParseRules.yaml)
- Engine: [`src/engine/sqlBodyParser.ts`](../src/engine/sqlBodyParser.ts)
- Microsoft T-SQL reference: <https://learn.microsoft.com/sql/t-sql/language-reference>
