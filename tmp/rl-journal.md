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
| FROM comma-join (old ANSI) | ✗ **Gap** | Wave 1 candidate |
| OUTPUT INTO catalog table | ✗ **Gap** | Wave 3 candidate |
| CTE-based UPDATE target | ✗ **Gap** | Wave 4 candidate |
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

### Wave 1 Plan: ANSI Comma-Join Coverage

**Target gap**: Patterns 1, 2 from gap table above (ANSI comma-join)

**Competing agents** (3-way):
- **Agent A (Conservative)**: Modify `extract_sources_ansi` to also match tables after commas in a FROM list. Pattern change: add a new alternative for `,\s*` before table name. Risk: may create false positives.
- **Agent B (Expansive)**: Add a new rule `extract_sources_comma_join` with pattern `(?:FROM\s+|,\s*)(schema.table)` that fires only after a confirmed FROM context. Cleaner separation.
- **Agent C (Structural)**: Add a preprocessing rule that rewrites `FROM t1, t2, t3` → `FROM t1 CROSS JOIN t2 CROSS JOIN t3` before extraction. Deterministic transformation, no regex ambiguity.

**Test**: `test/sql/targeted/ansi_old_01_comma_join.sql`, `ansi_old_02_outer_join_star.sql`, `ansi_old_04_mixed_modern_old.sql`
**Success criterion**: All 3 files pass EXPECT assertions with zero regressions in 283-SP snapshot.

---

### Wave 2 Plan: OUTPUT INTO Catalog Table

**Target gap**: Pattern 3 (OUTPUT INTO)

**Competing agents** (3-way):
- **Agent A**: Add `extract_output_into` rule: `\bOUTPUT\b[\s\S]{0,500}?\bINTO\s+(schema.table)` — captures the table after INTO within 500 chars of OUTPUT.
- **Agent B**: Extend `extract_targets_dml` to include OUTPUT INTO as a target. Would need: `(?:INSERT\s+(?:INTO\s+)?|UPDATE\s+|MERGE\s+(?:INTO\s+)?|OUTPUT\s+[\s\S]{0,500}?INTO\s+)`.
- **Agent C (Structural)**: Add a preprocessing rule that rewrites `OUTPUT...INTO [schema].[table]` → `__OUTPUT_TARGET__ [schema].[table]` and then a simple extraction rule catches it. Avoids complex regex.

**Test**: `test/sql/targeted/output_into_01-03.sql`
**Check first**: Frequency in 252 customer SPs (scan for OUTPUT keyword).

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
