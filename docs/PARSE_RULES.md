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
    pattern: "\\bFROM\\s+((?:\\[?\\w+\\]?\\.)*\\[?\\w+\\]?)"
    flags: gi                       # Regex flags
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

Preprocessing rules require a `replacement` field. All other rules use capture group 1 as the object reference.

## Built-in Rules (9)

| Rule | Category | Captures |
|------|----------|----------|
| `remove_comments` | preprocessing | `--` and `/* */` comments |
| `remove_string_literals` | preprocessing | String literals `'...'` |
| `extract_sources_ansi` | source | FROM / JOIN (all variants) |
| `extract_sources_tsql_apply` | source | CROSS APPLY / OUTER APPLY |
| `extract_merge_using` | source | MERGE ... USING source |
| `extract_targets_dml` | target | INSERT INTO / UPDATE / MERGE INTO |
| `extract_select_into` | target | SELECT INTO |
| `extract_ctas` | target | CREATE TABLE ... AS SELECT |
| `extract_sp_calls` | exec | EXEC / EXECUTE |

## Fallback Behavior

- **No YAML configured** — uses built-in defaults silently
- **YAML missing or invalid** — uses built-in defaults + shows a warning
- **YAML loads successfully** — replaces all defaults. Any rule not in your file is lost

## What Can't Be Customized

- **CTE extraction** — always active, runs after preprocessing. CTE names are excluded from source matches automatically
- **Catalog validation** — only references matching actual dacpac objects create edges
- **Skip lists** — overridable via `skip_prefixes` / `skip_keywords` in your YAML
