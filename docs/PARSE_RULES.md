# Custom Parse Rules

The extension extracts stored procedure dependencies using regex rules. Tables, views, and functions use dacpac XML dependencies directly — these rules only apply to SP body parsing.

## Setup

1. Run **Data Lineage: Create Parse Rules** to scaffold a `parseRules.yaml` in your workspace
2. Set `dataLineageViz.parseRulesFile` in VS Code settings to point to your file
3. Edit the YAML to add, remove, or modify rules

## Rule Format

```yaml
rules:
  - name: extract_sources_ansi     # Unique identifier
    enabled: true                   # Toggle on/off
    priority: 5                     # Execution order (lower = earlier)
    category: source                # preprocessing | source | target | exec
    pattern: "\\bFROM\\s+((?:(?:\\[[^\\]]+\\]|\\w+)\\.)*(?:\\[[^\\]]+\\]|\\w+))"
    flags: gi                       # Regex flags
    replacement: "..."                 # (preprocessing only) replacement string
    description: "FROM/JOIN sources"

skip_prefixes:                      # Ignore matches starting with these
  - "#"                             # Temp tables
  - "@"                             # Variables
  - "sys."                          # System objects

skip_keywords:                      # Ignore matches equal to these
  - select
  - where
```

## Categories

| Category | Purpose | Edge direction |
|----------|---------|----------------|
| `preprocessing` | Clean SQL before extraction (strip comments, strings) | N/A |
| `source` | Tables the SP reads from (FROM, JOIN, APPLY) | table -> SP |
| `target` | Tables the SP writes to (INSERT, UPDATE, MERGE) | SP -> table |
| `exec` | Procedures called via EXEC/EXECUTE | SP -> called_SP |

Extraction rules use capture group 1 as the object reference.

## Built-in Rules (11)

| Rule | Priority | Category | Captures |
|------|----------|----------|----------|
| `clean_sql` | 1 | preprocessing | Brackets `[...]` + strings `'...'` + comments `--` / `/* */` in one pass |
| `extract_sources_ansi` | 5 | source | FROM / JOIN (all variants) |
| `extract_targets_dml` | 6 | target | INSERT [INTO] / UPDATE / MERGE [INTO] |
| `extract_sources_tsql_apply` | 7 | source | CROSS APPLY / OUTER APPLY |
| `extract_sp_calls` | 8 | exec | EXEC / EXECUTE (including `@var = proc` pattern) |
| `extract_merge_using` | 9 | source | MERGE ... USING source |
| `extract_udf_calls` | 10 | source | Inline scalar UDF calls (`schema.func()`) |
| `extract_ctas` | 13 | target | CREATE TABLE ... AS SELECT |
| `extract_select_into` | 14 | target | SELECT INTO |
| `extract_copy_into` | 15 | target | COPY INTO (Fabric/Synapse) |
| `extract_bulk_insert` | 16 | target | BULK INSERT (SQL Server) |

**Preprocessing**: The `clean_sql` rule uses a single-pass combined regex where brackets, strings, and comments are matched together. The regex engine processes left-to-right — the **leftmost match wins**. A string like `' <--- ETL --->'` is matched as a string first, so `--` inside it is never treated as a comment. Brackets `[...]` are preserved (protecting quoted identifiers like `[column--name]`), strings are neutralized to `''`, comments are replaced with a space. This is the industry-standard "Best Regex Trick" for handling delimiter interactions.

## Fallback Behavior

- **No YAML configured** — uses built-in defaults silently
- **YAML missing or invalid** — uses built-in defaults + shows a warning
- **YAML loads successfully** — replaces all defaults. Any rule not in your file is lost

## XML Fallback Direction

When regex misses a dependency but XML BodyDependencies has it, the extension infers edge direction from the object type:

| Object type | Direction | Reason |
|-------------|-----------|--------|
| `procedure` | SP -> called proc (EXEC) | SP calls the procedure |
| `function` | function -> SP (READ) | Functions are read-only by definition |
| `view` | view -> SP (READ) | Views are read-only |
| `table` | table -> SP (READ) | Safest default; regex catches writes via INSERT/UPDATE/MERGE |

This is validated by the `testTypeAwareDirection` test which confirms 100% accuracy on both test dacpacs.

## Known Limitations

| Pattern | Behavior | Why | Workaround |
|---------|----------|-----|------------|
| `UPDATE alias SET ... FROM table alias` | Table classified as source (READ) instead of target (WRITE) | Alias resolution requires semantic analysis beyond regex | Use full table name in UPDATE: `UPDATE [dbo].[Table] SET ...` |
| `CTE(col1, col2) AS (...)` | CTE name may leak into sources | Column-list syntax not matched by CTE regex | Harmless — catalog resolution filters it |
| Dynamic SQL (`EXEC('...')`) | Content inside string not parsed | By design — cannot determine static dependencies | N/A |
| Nested block comments (`/* /* */ */`) | Outer comment may not fully close | Single regex can't count nesting depth | Uncommon in SP bodies |

All false positives are harmless — catalog resolution filters regex results against known dacpac objects. Only references matching real objects become graph edges.

## What Can't Be Customized

- **Preprocessing** — `clean_sql` is built-in (hardcoded function replacement). The YAML rule documents the pattern but execution is always handled by `parseSqlBody()`. You can add additional preprocessing rules in custom YAML.
- **CTE extraction** — always active, runs after preprocessing. CTE names are excluded from source matches automatically
- **Catalog validation** — only references matching actual dacpac objects create edges
- **Skip lists** — overridable via `skip_prefixes` / `skip_keywords` in your YAML
