# RL SQL Rule Engine Journal

## Wave 0 — Setup & Baseline (non-destructive)

**Branch**: `rl/wave-0-baseline` (from `claude/code-review-vscode-extension-CsDOg`)
**Date**: 2026-02-20

---

### What Was Built

#### Test Corpus (wave-0 branch only)

| Location | Files | Type | Ground Truth |
|----------|-------|------|-------------|
| `test/sql/targeted/` | 54 | Hand-crafted, one pattern per file | `-- EXPECT` annotation |
| `test/sql/real/` | 196 | Real-world SPs from GitHub (Brent Ozar, Ola Hallengren, WideWorldImporters, NAV, Darling Data, ktaranov, etc.) | Stability-only (no oracle) |
| `test/sql/generated/` | 310 | Synthetic SPs, template-based | `-- EXPECT` annotation |
| **Total** | **560** | | |

#### Infrastructure Files

| File | Purpose |
|------|---------|
| `test/tsql-complex.test.ts` | Test runner loading all `.sql` test files, parsing `-- EXPECT` annotations |
| `tmp/generate-test-sps.ts` | Synthetic SP generator (310 SPs, 5 tiers, 16 style flags) |
| `tmp/rl-baseline.tsv` | Dacpac snapshot baseline (283 SPs × 3 dacpacs) |
| `tmp/analyze-baseline.ts` | Baseline stats script |

---

### npm test Baseline

**Command**: `npm test` (all 6 suites)

| Suite | Tests | Pass | Fail |
|-------|-------|------|------|
| dacpacExtractor | 43 | 43 | 0 |
| graphBuilder | 47 | 47 | 0 |
| parser-edge-cases | 142 | 142 | 0 |
| graphAnalysis | 59 | 59 | 0 |
| dmvExtractor | 51 | 51 | 0 |
| **tsql-complex (new)** | **560** | **552** | **8** |
| **Total** | **902** | **894** | **8** |

**Pass rate on new suite**: 552/560 = **99%**

The 8 failures are clean parser gaps (RL targets). All 342 existing tests pass with zero regressions.

---

### Dacpac Snapshot Baseline

**File**: `tmp/rl-baseline.tsv` | **Date**: 2026-02-20

| Dacpac | SPs | Have ≥1 dep | No deps found |
|--------|-----|------------|---------------|
| Classic (AdventureWorks) | 10 | 9 (90%) | 1 (10%) |
| SDK-style (AdventureWorks Fabric) | 21 | 12 (57%) | 9 (43%) |
| Customer (Synapse_Data_Warehouse) | 252 | 252 (100%) | 0 (0%) |
| **Total** | **283** | **273 (96%)** | **10 (4%)** |

**Dependency breakdown across 283 SPs**:
- Source-only SPs (reads, no writes): 25
- Target-only SPs (writes, no reads): 12
- Both source + target: 219
- SPs with exec calls: 240

**Note**: SDK-style dacpac has 9 SPs with no deps found. These are Fabric-specific patterns (COPY INTO, CTAS) or SPs that only use temp tables — not parser failures.

---

### 8 Identified Parser Gaps (RL Targets for Waves 1–4)

| # | Pattern | File(s) | Gap Description | Priority |
|---|---------|---------|-----------------|----------|
| 1 | **ANSI comma-join** | `ansi_old_01`, `ansi_old_02`, `ansi_old_04` | `FROM t1, t2, t3` — only first table after FROM captured; remaining comma-separated tables missed. `extract_sources_ansi` requires `FROM\|JOIN` keyword before each table. | Medium |
| 2 | **No-whitespace SQL** | `bad_format_01` | `from[dbo].[Table]` (no space between keyword and `[bracket`) — regex requires `\s+` after keyword. Legacy or minimized SQL. | Low |
| 3 | **OUTPUT INTO catalog table** | `output_into_01`, `output_into_02`, `output_into_03` | `OUTPUT INSERTED.x INTO [schema].[table]` — second write target not captured. The `OUTPUT...INTO` pattern not covered by any current rule. Common in audit/staging patterns. | High |
| 4 | **CTE-based UPDATE** | `update_alias_03` | `WITH cte AS (...) UPDATE cte SET...` — the underlying table (defined in CTE) not resolved as target. `extract_update_alias_target` requires `FROM` clause in UPDATE. CTE UPDATE has no FROM. | Medium |

### Gap Pattern Analysis

**Gap 1 (ANSI comma-join)**: Pre-SQL-92 T-SQL. SQL Server 6.5/7.0 era codebases. The pattern `FROM t1, t2, t3 WHERE t1.id = t2.id` joins multiple tables in the WHERE clause. `extract_sources_ansi` uses `\b(?:FROM|JOIN)\s+` — fires once per keyword. After the first table, the comma-separated tables have no preceding FROM/JOIN. Frequency in modern codebases: low. Frequency in legacy MSSQL: moderate.

**Gap 2 (No-whitespace)**: SQL with `from[table]`, `join[table]`, `exec[proc]` with zero whitespace between keyword and identifier. Requires `\s+` → `\s*` change (and possible `\b` boundary adjustment). Risk: may increase false positives in other patterns. Frequency: rare except in minified/generated SQL.

**Gap 3 (OUTPUT INTO)**: This is the highest-value gap. The `OUTPUT...INTO [schema].[table]` pattern writes to a second table — an audit trail or staging table. This is missed entirely. The current rules don't have an `extract_output_into` rule. Adding one would improve coverage for ETL SPs that use OUTPUT for audit logging. Frequency in customer dacpac: unknown until Wave 3 investigation.

**Gap 4 (CTE UPDATE)**: `UPDATE InventoryWithSales SET...` where InventoryWithSales is a CTE alias. The actual target is `[dbo].[Inventory]` (the base table defined in the CTE). This requires either: (a) preprocessing to resolve CTE aliases before extraction, or (b) a special rule that finds `WITH cte AS (SELECT ... FROM base)...UPDATE cte` and extracts base as target. Frequency: moderate in complex update patterns.

---

### Pattern Taxonomy of Currently Handled Cases

Based on 557 passing oracle tests and 283 dacpac SPs:

| Category | Status | Rule |
|----------|--------|------|
| `SELECT ... FROM [schema].[table]` | ✓ Handled | `extract_sources_ansi` |
| `JOIN [schema].[table]` | ✓ Handled | `extract_sources_ansi` |
| `CROSS/OUTER APPLY [schema].[table]` | ✓ Handled | `extract_sources_tsql_apply` |
| `MERGE ... USING [schema].[source]` | ✓ Handled | `extract_merge_using` |
| `MERGE INTO [schema].[target]` | ✓ Handled | `extract_targets_dml` |
| `INSERT INTO [schema].[table]` | ✓ Handled | `extract_targets_dml` |
| `UPDATE [schema].[table] SET...` | ✓ Handled | `extract_targets_dml` |
| `UPDATE alias SET...FROM [schema].[table]` | ✓ Handled | `extract_update_alias_target` |
| `SELECT INTO [schema].[table]` | ✓ Handled | `extract_select_into` |
| `COPY INTO [schema].[table]` | ✓ Handled | `extract_copy_into` |
| `BULK INSERT [schema].[table]` | ✓ Handled | `extract_bulk_insert` |
| `EXEC [schema].[proc]` | ✓ Handled | `extract_sp_calls` |
| `[schema].[udf](...)` | ✓ Handled | `extract_udf_calls` |
| `DECLARE @var TABLE (...)` | ✓ Handled | Rejected by normalizeCaptured |
| `#temp` tables | ✓ Handled | Rejected by normalizeCaptured |
| Block comments | ✓ Handled | Pass 0 counter-scan |
| String literals | ✓ Handled | Pass 1 leftmost-match |
| Line comments | ✓ Handled | Pass 1 leftmost-match |
| Nested block comments | ✓ Handled | Pass 0 counter-scan |
| Brackets with spaces `[CRONUS Int Ltd_$X]` | ✓ Handled | `\[[^\]]+\]` matches spaces |
| EXECUTE AS context clause | ✓ Handled | `(?!AS\s+)` in extract_sp_calls |
| CTE chain (base tables found) | ✓ Handled | CTE names have no dot → rejected |
| `DELETE FROM [schema].[table]` | ✓ Handled | `extract_targets_dml` (Wave 2) |
| `OUTPUT...INTO [schema].[table]` | ✓ Handled | `extract_output_into` (Wave 2) |
| FROM comma-join (old ANSI) | ✓ Handled | `normalizeAnsiCommaJoins()` (Wave 1) |
| CTE-based UPDATE target | ✗ **Gap** | Wave 3 target |
| No-whitespace SQL | ✗ **Gap** | Low priority |
| Dynamic SQL `EXEC(@var)` | — By design | Not parseable |
| OPENQUERY / linked servers | — By design | 4-part refs rejected |

---

### Synthetic Generator Quality

**310 files generated** (50 tiny, 100 medium, 80 large, 50 monster, 30 dmv-style)

Pass rate on generated SPs: **310/310 = 100%** (after fixing generator's `applyNoFormatting` bug)

**Key bug found and fixed**: `applyNoFormatting` joined all lines onto one line but kept `--` inline comments, which then ate the rest of the SQL (the `--[^\r\n]*` regex has no line boundary when the "line" is the entire file). Fixed by stripping `--` comments from each line before joining.

**Style flag coverage in generated SPs**:
- `noFormatting`: ~1/16 chance per file → ~19 tiny, 37 medium, 30 large, 19 monster, 11 dmv-style
- `deepTryCatch`: contributes to ~10% of files
- `tempTableHeavy`: validated — #temp table refs not captured (correct)
- `variableTableHeavy`: validated — @var table refs not captured (correct)
- `massiveComments`: validated — comment content not extracted (correct)
- `commentedOutSQL`: validated — commented SQL not extracted (correct)
- `cursorLoop`: validated — cursor vars not captured

---

### Wave 1: ANSI Comma-Join Coverage

**Branch**: `rl/wave-1-comma-join` (from `rl/wave-0-baseline`)
**Date**: 2026-02-20

**Target gap**: 3 failing tests — `ansi_old_01`, `ansi_old_02`, `ansi_old_04`
**Root cause**: `extract_sources_ansi` requires `FROM|JOIN` keyword before each table. In `FROM t1, t2, t3`, only `t1` (after FROM) is captured; `t2`, `t3` have no keyword prefix.

---

#### Three-Way Agent Competition

**Agent A (Conservative YAML)**: Modify `extract_sources_ansi` to also match `, schema.table` after commas.

*Attempt 1* — Schema-length guard `\w{3,}`: Pattern `(?:FROM|JOIN\s+|,\s*(?=\w{3,}\.))`. **FAILED** — multi-char table aliases (e.g. `jobs`, `sched`, `svr` in msdb SQL) pass the 3-char guard → runaway extraction (729 sources in `sqlserver2019_instmsdb.sql`, ≥500 limit exceeded).

*Attempt 2* — Bracket-only variant: `,\s*(?=\[[^\]]+\]\.\[)`. **PARTIAL** — fixes `ansi_old_04` (bracket-quoted tables) but NOT `ansi_old_01`/`ansi_old_02` (unbracketed). Zero stability failures.

| Metric | Agent A result |
|--------|---------------|
| Tests | 553/560 (+1 from 552) |
| Stability failures | 0 |
| Snapshot regressions | 0 |
| Snapshot improvements | 0 |
| **Score** | **2** |

---

**Agent B (YAML lookbehind)**: Add `extract_sources_comma_join` rule with lookbehind `(?<=\bFROM\b[^;]*)` to check FROM appeared before the comma.

*Problem diagnosed*: The lookbehind crosses `GO` batch separators in large multi-statement SQL files. The msdb install script (`sqlserver2019_instmsdb.sql`) has hundreds of SPs — a FROM from SP#N appears before SELECT commas of SP#N+1 (no `;` barrier between `GO`-separated batches). Result: 729/735 false sources.

**DISQUALIFIED** — stability failures in 2 real-world test files.

| Metric | Agent B result |
|--------|---------------|
| Tests | 553/560 |
| Stability failures | **2** (immediate disqualification) |
| **Score** | **-∞** |

---

**Agent C (TypeScript forward-scan)**: Add `normalizeAnsiCommaJoins()` function to `sqlBodyParser.ts` that uses a forward-scanning regex to match `FROM t1 a1, t2 a2, ..., tN aN <terminator>` as a single pattern and replace commas with JOIN, then `extract_sources_ansi` captures all tables via the JOIN branch.

*Key insight*: The forward-scanning pattern `\bFROM\s+(table,table,...)(table)(?=WHERE|JOIN|ORDER|...)` can only fire when FROM is literally followed by comma-separated tables. SELECT-list commas (which appear BEFORE FROM, not after) are structurally excluded. No lookbehind needed. No cross-statement boundary issues.

```typescript
function normalizeAnsiCommaJoins(sql: string): string {
  const tableRef = '(?:\\[[^\\]]+\\]|\\w+)\\.(?:\\[[^\\]]+\\]|\\w+)(?:\\s+(?:AS\\s+)?\\w+)?';
  return sql.replace(
    new RegExp(
      `\\bFROM\\s+((?:${tableRef}\\s*,\\s*)+${tableRef})` +
      '(?=\\s*(?:WHERE\\b|JOIN\\b|INNER\\b|LEFT\\b|RIGHT\\b|FULL\\b|CROSS\\b|OUTER\\b|ON\\b|ORDER\\b|GROUP\\b|HAVING\\b|WITH\\b|SET\\b|;|\\)|$))',
      'gi'
    ),
    (_, tables: string) => 'FROM ' + tables.replace(/\s*,\s*/g, ' JOIN ')
  );
}
```

Called in `parseSqlBody()` after Pass 1 cleansing (Pass 1.5), before YAML extraction rules.

| Metric | Agent C result |
|--------|---------------|
| Tests | **555/560 (+3 from 552)** |
| Stability failures | 0 |
| Snapshot regressions | 0 |
| Snapshot improvements | 1 SP (`spCreateSnapshot`: `[sys].[dm_pdw_exec_requests]` now found) |
| **Score** | **8** |

---

#### Agent C Wins

All 3 targeted tests now pass:
- `ansi_old_01_comma_join.sql`: src=4 (was src=1) ✓
- `ansi_old_02_outer_join_star.sql`: src=4 (was src=1) ✓
- `ansi_old_04_mixed_modern_old.sql`: src=4 (was src=2) ✓

Zero regressions on all 342 existing tests. Zero snapshot regressions on 283 dacpac SPs.

**Remaining gap count**: 5 oracle failures (was 8 at wave 0):
- `output_into_01`, `output_into_02`, `output_into_03` — OUTPUT INTO catalog (Wave 2 target)
- `update_alias_03` — CTE-based UPDATE target (Wave 3 target)
- `bad_format_01` — No-whitespace SQL (Low priority)

**Files changed on this branch**:
- `src/engine/sqlBodyParser.ts` — added `normalizeAnsiCommaJoins()` + call in `parseSqlBody()`
- `tmp/wave1-agent-c.tsv` — snapshot after wave 1
- `tmp/rl-journal.md` — this entry

---

### Wave 2: OUTPUT INTO + DELETE FROM Targets

**Branch**: `rl/wave-2-output-into` (from `rl/wave-1-comma-join`)
**Date**: 2026-02-20

**Target gaps**:
- Pattern 3 (OUTPUT INTO): `output_into_01`, `output_into_02`, `output_into_03`
- Bonus: DELETE FROM treated as target (was only showing as source via FROM keyword)

**Pre-check**: 26/252 customer SPs (10%) use `OUTPUT...INTO`. All INTO targets in customer data are `@tableVar` or `#temp` — rejected by `normalizeCaptured()`. So the rule is correct by design but customer dacpac snapshot shows 0 improvement (all catalog improvements come from targeted tests).

---

#### Root Cause Analysis

All 3 failing tests share the same structure:
- `INSERT/UPDATE/DELETE FROM [dbo].[primaryTable] ... OUTPUT INSERTED/DELETED.* INTO [schema].[secondTable]`
- `[schema].[secondTable]` was either missing from targets OR incorrectly in sources (via `extract_udf_calls` false positive: `[schema].[table](` matched as UDF call because column list follows)

**UDF false positive mechanism**: `extract_udf_calls` pattern `(schema.obj)\s*\(` fires on `INTO [dbo].[MessageArchive] (col1, col2)` because `(` follows the table name. Self-corrects once the table is in targets (filter: "add UDF sources not already in targets").

**DELETE FROM gap**: `extract_targets_dml` previously excluded DELETE. `DELETE FROM [dbo].[Session]` was captured as SOURCE by `extract_sources_ansi` (FROM keyword match), NOT as target. For `output_into_03`, we need `[dbo].[Session]` in targets.

---

#### Agent A (Winner — YAML changes only)

Two changes to `assets/defaultParseRules.yaml`:

**Change 1**: Extended `extract_targets_dml` to include `DELETE\s+FROM\s+`:
```yaml
pattern: "\\b(?:INSERT\\s+(?:INTO\\s+)?|UPDATE\\s+|DELETE\\s+FROM\\s+|MERGE\\s+(?:INTO\\s+)?)((?:(?:\\[[^\\]]+\\]|\\w+)\\.)*(?:\\[[^\\]]+\\]|\\w+))"
```
**Change 2**: New `extract_output_into` rule (priority 18):
```yaml
- name: extract_output_into
  enabled: true
  priority: 18
  category: target
  pattern: "\\bOUTPUT\\b[^;]{0,500}?\\bINTO\\s+((?:(?:\\[[^\\]]+\\]|\\w+)\\.)*(?:\\[[^\\]]+\\]|\\w+))"
  flags: gi
  description: "OUTPUT ... INTO [schema].[table] — uses [^;] (not [\s\S]) to prevent cross-statement matches"
```

**Key design choice**: `[^;]` instead of `[\s\S]` in OUTPUT INTO pattern. `[\s\S]` crosses statement boundaries and can match EXEC output parameters (`EXEC proc @result OUTPUT` then later `INTO table`). `[^;]` hard-stops at semicolons, keeping the match within one statement.

**Test updated**: `parser-edge-cases.test.ts` test "DELETE FROM excluded from lineage" updated to reflect new behavior (DELETE IS now a lineage target).

| Metric | Agent A result |
|--------|---------------|
| Tests (342 unit) | **342/342** (all pass) |
| Tests (tsql-complex) | **558/560 (+3 from 555)** |
| Stability failures | 0 |
| Snapshot regressions | 0 |
| Snapshot improvements | 0 (customer OUTPUT INTO all @vars) |
| **Score** | **6** (3 improved × 2) |

**Agents B/C**: Not run — Agent A achieves zero regressions + full target coverage. No need to compete.

---

#### Wave 2 Summary

All 3 OUTPUT INTO targeted tests now pass:
- `output_into_01_insert.sql`: `[dbo].[MessageArchive]` now in targets (not sources) ✓
- `output_into_02_update_archive.sql`: `[audit].[AccountChangeLog]` now in targets ✓
- `output_into_03_delete.sql`: `[dbo].[Session]` (DELETE target) + `[dbo].[ExpiredSession]` (OUTPUT INTO) both in targets ✓

**Remaining gap count**: 2 oracle failures (was 5 before wave 2):
- `update_alias_03` — CTE-based UPDATE target (Wave 3 target)
- `bad_format_01` — No-whitespace SQL (Low priority)

**Files changed on this branch**:
- `assets/defaultParseRules.yaml` — extended `extract_targets_dml` + new `extract_output_into` rule
- `test/parser-edge-cases.test.ts` — updated DELETE FROM test to reflect new behavior
- `tmp/wave2-agent-a.tsv` — snapshot after wave 2
- `tmp/rl-journal.md` — this entry

---

---

### Wave 3 Plan: CTE-Based UPDATE

**Target gap**: Pattern 4 (CTE UPDATE)

This is the most complex gap. CTE UPDATE requires understanding that `UPDATE cte_name` refers to the base table defined in the WITH clause. Options:
- **Agent A**: Pattern `WITH\s+(\w+)\s+AS\s*\(.*?FROM\s+(schema.table).*?\)\s*UPDATE\s+\1\s+SET` — complex multi-line regex.
- **Agent B**: Two-pass approach: first extract all CTE definitions and their base tables, then check if any UPDATE targets a CTE name.
- **Agent C**: Skip for now — document as a known structural limitation. The value-complexity ratio is unclear without frequency data.

**Pre-check**: How often does the customer dacpac use CTE-based UPDATE? If less than 5 SPs, the complexity cost > coverage gain.

---

### Wave 4 Plan: Final Review & Recommendation

After Waves 1–3, re-run snapshot and measure:
1. How much did coverage improve?
2. Final gap taxonomy: what remains?
3. Recommendation table: implement / defer / by-design

---

### Files Changed on Wave 0 Branch

- `test/sql/targeted/` — 54 targeted SQL pattern files
- `test/sql/real/` — 161 real-world SQL files
- `test/sql/generated/` — 310 synthetic SQL files
- `test/tsql-complex.test.ts` — new test runner
- `tmp/generate-test-sps.ts` — synthetic SP generator
- `tmp/rl-baseline.tsv` — dacpac snapshot baseline
- `tmp/rl-journal.md` — this file
- `package.json` — `tsql-complex.test.ts` added to test script

**Parser files NOT changed** (parser is unchanged on this branch):
- `assets/defaultParseRules.yaml` — unchanged
- `src/engine/sqlBodyParser.ts` — unchanged
- `src/utils/sql.ts` — unchanged
