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
```

## Parsing Pipeline

```
SQL body
  → Stage 1: Preprocessing (clean_sql — strip comments, neutralize strings)
  → Stage 2: CTE extraction (names excluded from source matches)
  → Stage 3: Regex extraction (rules by priority: sources, targets, exec)
  → Stage 4: Qualification filter (unqualified names and system schemas silently skipped)
  → Stage 5: Catalog validation (only real objects become edges)
```

Stage 4 and 5 run in `modelBuilder`:
- **Qualification filter**: regex results without a schema qualifier (no dot) are collected as debug-only `skippedRefs` and never added to the graph or shown as unresolved references. System-schema refs (`sys.*`, `information_schema.*`) are also silently skipped. The parser only supports **fully-qualified two-part names** (`[schema].[object]`).
- **Catalog validation**: schema-qualified refs are checked against the catalog of known objects (dacpac XML or DB DMVs). Only matching refs create graph edges.

## Filtering Layers

| Filter | When | What | Configurable |
|--------|------|------|-------------|
| Qualification filter | Graph build | Unqualified (no dot) and system-schema refs are skipped silently | Hardcoded |
| Catalog resolution | Graph build | Only schema-qualified refs matching real objects become edges | Automatic |
| `excludePatterns` | Post-graph | User hides real objects from visualization | VS Code settings |

## Categories

| Category | Purpose | Edge direction |
|----------|---------|----------------|
| `preprocessing` | Clean SQL before extraction (strip comments, strings) | N/A |
| `source` | Tables the SP reads from (FROM, JOIN, APPLY) | table -> SP |
| `target` | Tables the SP writes to (INSERT, UPDATE, MERGE) | SP -> table |
| `exec` | Procedures called via EXEC/EXECUTE | SP -> called_SP |

Extraction rules use capture group 1 as the object reference.

## Built-in Rules (12)

| Rule | Priority | Category | Captures |
|------|----------|----------|----------|
| `clean_sql` | 1 | preprocessing | Brackets `[...]` + strings `'...'` + comments `--` / `/* */` in one pass |
| `extract_sources_ansi` | 5 | source | FROM / JOIN (all variants) |
| `extract_targets_dml` | 6 | target | INSERT [INTO] / UPDATE [schema.table] / MERGE [INTO] |
| `extract_sources_tsql_apply` | 7 | source | CROSS APPLY / OUTER APPLY |
| `extract_sp_calls` | 8 | exec | EXEC / EXECUTE (including `@var = proc` pattern) |
| `extract_merge_using` | 9 | source | MERGE ... USING source |
| `extract_udf_calls` | 10 | source | Inline scalar UDF calls (`schema.func()`) |
| `extract_ctas` | 13 | target | CREATE TABLE ... AS SELECT |
| `extract_select_into` | 14 | target | SELECT INTO |
| `extract_copy_into` | 15 | target | COPY INTO (Fabric/Synapse) |
| `extract_bulk_insert` | 16 | target | BULK INSERT (SQL Server) |
| `extract_update_alias_target` | 17 | target | UPDATE alias SET ... FROM schema.table (alias case) |

**Preprocessing**: The `clean_sql` rule uses a single-pass combined regex where brackets, strings, and comments are matched together. The regex engine processes left-to-right — the **leftmost match wins**. A string like `' <--- ETL --->'` is matched as a string first, so `--` inside it is never treated as a comment. Brackets `[...]` are preserved (protecting quoted identifiers like `[column--name]`), strings are neutralized to `''`, comments are replaced with a space. This is the industry-standard "Best Regex Trick" for handling delimiter interactions.

**UPDATE alias handling**: `extract_targets_dml` (priority 6) handles `UPDATE [schema].[Table]` directly. `extract_update_alias_target` (priority 17) handles `UPDATE alias SET ... FROM [schema].[Table]` — the negative lookahead `(?!\[?\w+\]?\s*\.)` ensures the two rules are mutually exclusive. When the alias rule fires, the FROM table also appears as a source (via `extract_sources_ansi`), producing a `⇄` bidirectional edge — semantically correct since the SP both reads and writes the target table.

## Fallback Behavior

- **No YAML configured** — loads built-in rules from `assets/defaultParseRules.yaml` silently
- **Custom YAML missing or invalid** — falls back to built-in rules + shows a warning
- **Custom YAML loads successfully** — replaces all built-in rules. Any rule not in your file is lost

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
| `UPDATE alias SET ... FROM table alias` (subquery in SET) | Subquery table may be captured instead of outer FROM table | Non-greedy span picks first qualified name after FROM | Avoid subqueries in the SET clause when the table alias pattern is used; or use `UPDATE [schema].[Table] SET ...` directly |
| Dynamic SQL (`EXEC('...')`) | Content inside string not parsed | By design — cannot determine static dependencies | N/A |
| Nested block comments (`/* /* */ */`) | Outer comment may not fully close | Single regex can't count nesting depth | Uncommon in SP bodies |
| No whitespace before bracket identifiers (`from[dbo].[T]`, `exec[dbo].[sp]`) | Dependency not detected | All rules require at least one space between keyword and object name — valid SQL but extremely rare formatting | Add a space: `FROM [dbo].[T]` |
| Chained CTEs in UPDATE (`WITH c2 AS (… FROM c1) UPDATE c2`) | Write target not detected | `c1` has no schema dot — chain not resolved | Rewrite using `UPDATE [schema].[T]` directly instead of a chained CTE alias |

All false positives are harmless — catalog resolution filters regex results against known objects (dacpac or database). Only references matching real objects become graph edges. Unqualified references (CTEs, table aliases, built-in rowset functions like `FREETEXTTABLE`) are silently skipped before catalog lookup and never shown as unresolved.

## What Can't Be Customized

- **Preprocessing** — `clean_sql` is built-in (hardcoded function replacement). The YAML rule documents the pattern but execution is always handled by `parseSqlBody()`. You can add additional preprocessing rules in custom YAML.
- **CTE extraction** — always active, runs after preprocessing. CTE names are excluded from source matches automatically
- **Qualification filter** — hardcoded in `modelBuilder`: unqualified and system-schema refs are always skipped
- **Catalog validation** — only references matching real objects create edges (dacpac XML or DB DMV queries)
