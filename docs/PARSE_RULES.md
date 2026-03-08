# Custom Parse Rules

The extension extracts stored procedure dependencies using regex rules. Tables, views, and functions use dacpac XML dependencies directly — these rules only apply to SP body parsing.

## Setup

1. Open the **Command Palette** (`Ctrl+Shift+P`) and run **Data Lineage: Create Parse Rules** — this copies the built-in YAML into your workspace as `parseRules.yaml`
2. Set `dataLineageViz.parseRulesFile` to `parseRules.yaml` in VS Code Settings (`Ctrl+,`, search "dataLineageViz")
3. Edit the YAML to add, remove, or modify rules
4. Each rule is validated individually on load (regex compile + empty-match check). Invalid rules are skipped — valid rules still load. Check the Output channel for details

## Rule Format

```yaml
rules:
  - name: extract_sources_ansi     # Unique identifier
    enabled: true                   # Toggle on/off
    priority: 5                     # Execution order (lower = earlier)
    category: source                # preprocessing | source | target | exec | external_ref
    pattern: "\\bFROM\\s+((?:(?:\\[[^\\]]+\\]|\\w+)\\.)*(?:\\[[^\\]]+\\]|\\w+))"
    flags: gi                       # Regex flags
    replacement: "..."              # (preprocessing only) replacement string
    kind: "file"                    # (external_ref only) "file" | "db"
    description: "FROM/JOIN sources"
```

## Parsing Pipeline

```
SQL body
  → Stage 1: Preprocessing (TypeScript passes: block comments, strings, line comments, comma-joins, CTE alias substitution)
  → Stage 2: YAML rule extraction (rules by priority: sources, targets, exec)
  → Stage 3: Capture normalization (normalizeCaptured: rejects @vars, #temps, unqualified names, 4-part linked-server refs)
  → Stage 4: Catalog validation (only real objects become edges)
```

Stage 4 runs in `modelBuilder.ts`:
- **Catalog validation**: schema-qualified refs are checked against the catalog of known objects (dacpac XML or DB DMVs). Only matching refs create graph edges. Unqualified and system-schema refs (`sys.*`, `information_schema.*`) are rejected earlier in Stage 3 by `normalizeCaptured()`.

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
| `external_ref` | External file/URL references (OPENROWSET, COPY, BULK) | Virtual node (file) |

Extraction rules use capture group 1 as the object reference.

## Built-in Rules (17)

| Rule | Priority | Category | Captures |
|------|----------|----------|----------|
| `clean_sql` | 1 | preprocessing | Brackets `[...]` + strings `'...'` + comments `--` / `/* */` in one pass |
| `extract_sources_ansi` | 5 | source | FROM / JOIN (all variants) |
| `extract_targets_dml` | 6 | target | INSERT [INTO] / UPDATE / DELETE FROM / MERGE [INTO] |
| `extract_sources_tsql_apply` | 7 | source | CROSS APPLY / OUTER APPLY |
| `extract_sp_calls` | 8 | exec | EXEC / EXECUTE (including `@var = proc` pattern) |
| `extract_merge_using` | 9 | source | MERGE ... USING source |
| `extract_udf_calls` | 10 | source | Inline scalar UDF calls (`schema.func()`) |
| `extract_ctas` | 13 | target | CREATE TABLE ... AS SELECT |
| `extract_select_into` | 14 | target | SELECT INTO |
| `extract_copy_into` | 15 | target | COPY INTO (Fabric/Synapse) |
| `extract_bulk_insert` | 16 | target | BULK INSERT (SQL Server) |
| `extract_update_alias_target` | 17 | target | UPDATE alias SET ... FROM schema.table (alias case) |
| `extract_output_into` | 18 | target | OUTPUT ... INTO schema.table (audit/staging tables) |
| `extract_cetas` | 19 | target | CREATE EXTERNAL TABLE ... AS SELECT (Fabric/Synapse) |
| `extract_openrowset` | 20 | external_ref | OPENROWSET(BULK 'path', ...) file references |
| `extract_copy_from` | 21 | external_ref | COPY INTO ... FROM 'path' file references |
| `extract_bulk_from` | 22 | external_ref | BULK INSERT ... FROM 'path' file references |

**Preprocessing**: The `clean_sql` rule uses a single-pass combined regex where brackets, strings, and comments are matched together. The regex engine processes left-to-right — the **leftmost match wins**. A string like `' <--- ETL --->'` is matched as a string first, so `--` inside it is never treated as a comment. Brackets `[...]` are preserved (protecting quoted identifiers like `[column--name]`), strings are neutralized to `''`, comments are replaced with a space. This is the industry-standard "Best Regex Trick" for handling delimiter interactions.

**UPDATE alias handling**: `extract_targets_dml` (priority 6) handles `UPDATE [schema].[Table]` directly. `extract_update_alias_target` (priority 17) handles `UPDATE alias SET ... FROM [schema].[Table]` — the negative lookahead `(?!\[?\w+\]?\s*\.)` ensures the two rules are mutually exclusive. When the alias rule fires, the FROM table also appears as a source (via `extract_sources_ansi`), producing a `⇄` bidirectional edge — semantically correct since the SP both reads and writes the target table.

## Fallback Behavior

- **No YAML configured** — loads built-in rules from `assets/defaultParseRules.yaml` silently
- **Custom YAML missing or invalid** — falls back to built-in rules + shows VS Code warning dialog + logs to Output channel
- **Custom YAML loads successfully** — replaces all built-in rules. Any rule not in your file is lost
- **Individual rule invalid** (bad regex, empty-match, wrong category) — that rule is skipped, remaining valid rules still load. Skipped rules listed in the warning
- **Both custom and built-in fail** (should never happen) — error logged, regex-based edge detection disabled. Metadata dependencies (XML/DMV) still work

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
| Chained CTEs with no schema ref (`WITH c2 AS (… FROM c1) UPDATE c2`) | Write target not detected | `c1` has no schema dot — chain not resolved by the CTE alias substitution pass | Rewrite using `UPDATE [schema].[T]` directly |
| No whitespace before bracket identifiers (`from[dbo].[T]`, `exec[dbo].[sp]`) | Dependency not detected | All rules require at least one space between keyword and object name — valid SQL but extremely rare formatting | Add a space: `FROM [dbo].[T]` |

All false positives are harmless — catalog resolution filters regex results against known objects (dacpac or database). Only references matching real objects become graph edges. Unqualified references (CTEs, table aliases, built-in rowset functions like `FREETEXTTABLE`) are silently skipped before catalog lookup and never shown as unresolved.

## What Can't Be Customized

- **Preprocessing** — the four TypeScript passes (block comment removal, leftmost-match string/comment neutralization, ANSI comma-join normalization, CTE alias substitution) are hardcoded in `parseSqlBody()`. The `clean_sql` YAML rule documents the behavior but is not executed. You can add extra preprocessing rules in custom YAML.
- **Capture normalization** — `normalizeCaptured()` always rejects `@vars`, `#temps`, unqualified names, and 4-part linked-server refs. Not configurable.
- **Catalog validation** — only references matching real objects create edges (dacpac XML or DB DMV queries)
