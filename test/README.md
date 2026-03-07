# Test Suite

## Running Tests

```bash
npm test                                       # Run all unit tests (622 total)
npx tsx test/dacpacExtractor.test.ts           # Dacpac extractor tests (59 tests)
npx tsx test/graphBuilder.test.ts              # Graph builder + trace tests (84 tests)
npx tsx test/parser-edge-cases.test.ts         # Syntactic parser tests (175 tests)
npx tsx test/graphAnalysis.test.ts             # Graph analysis tests (59 tests)
npx tsx test/dmvExtractor.test.ts              # DMV extractor tests (146 tests)
npx tsx test/tsql-complex.test.ts              # SQL pattern tests (54 tests)
npx tsx test/profilingEngine.test.ts           # Profiling engine tests (45 tests)
```

## Test Files

| File | Tests | Purpose |
|------|-------|---------|
| `dacpacExtractor.test.ts` | 59 | Dacpac extraction, filtering, edge integrity, Fabric SDK, type-aware direction, CVE security, error handling, constraint extraction (UQ/CK/FK) |
| `graphBuilder.test.ts` | 84 | Graph construction, dagre layout, BFS trace, cross-connection exclusion, co-writer filter |
| `parser-edge-cases.test.ts` | 175 | **Syntactic parser tests** — pure regex rule verification, no dacpac data |
| `graphAnalysis.test.ts` | 59 | Graph analysis: islands, hubs, orphans, longest path, cycles |
| `dmvExtractor.test.ts` | 146 | DMV extractor: synthetic data, column validation, type formatting, fallback body direction, external tables, schema placeholder expansion |
| `tsql-complex.test.ts` | 54 | **SQL pattern tests** — targeted SQL files covering each parser pattern; expected results embedded as `-- EXPECT` comments |
| `profilingEngine.test.ts` | 45 | Table statistics: query generation, column classification, sampling logic, result parsing |

## Dacpac Extractor Tests (`dacpacExtractor.test.ts`)

Tests the dacpac import pipeline end-to-end, covering both classic (Azure SQL) and SDK-style (Fabric DW) dacpacs:

| Section | What it validates |
|---------|-------------------|
| DACPAC Extraction | Node/edge counts, schemas, object types from classic dacpac |
| Schema Filtering | Schema filter + max node cap |
| Edge Integrity | No dangling edges, no self-loops, no duplicates |
| Fabric SDK Dacpac | Views/tables/procs/functions counts, QueryDependencies, BodyDependencies |
| Type-Aware Direction | XML object type matches regex direction for all overlap deps (both dacpacs) |
| Security: CVE-2026-25128 | Out-of-range numeric entity handling in fast-xml-parser v5 |
| Import Error Handling | Non-ZIP, empty file, missing model.xml, empty dacpac warnings |
| Constraints | UQ/CK column flags and FK section in table design view; SDK-style dacpac shows "(none)" |

## Graph Builder Tests (`graphBuilder.test.ts`)

Tests graph construction and the BFS trace engine:

| Section | What it validates |
|---------|-------------------|
| Graph Builder | Layout, positions, metrics, trace reachability |
| Trace: No Siblings | BFS trace excludes cross-connection edges (leveled + unlimited + upstream-only) |
| Trace: Co-Writer Filter | Co-writers excluded, bidirectional kept, table-origin passthrough |
| Synapse Dacpac: Trace | Real SDK-style dacpac trace with cross-connection validation |

## Syntactic Parser Tests (`parser-edge-cases.test.ts`)

These tests verify every regex rule in `sqlBodyParser.ts` using synthetic SQL — no real dacpac data. They are the **primary regression guard** for parser changes. Each test calls `parseSqlBody()` directly and asserts exact sources/targets/execCalls.

| Section | What it validates | Rule(s) tested |
|---------|-------------------|----------------|
| 1. Preprocessing | String/comment/bracket neutralization | `clean_sql` |
| 2. Source extraction | FROM, JOIN variants, APPLY, MERGE USING | `extract_sources_ansi`, `extract_sources_tsql_apply`, `extract_merge_using` |
| 3. Target extraction | INSERT, UPDATE, MERGE, CTAS, SELECT INTO, COPY INTO, BULK INSERT | `extract_targets_dml`, `extract_ctas`, `extract_select_into`, `extract_copy_into`, `extract_bulk_insert` |
| 4. EXEC calls | EXEC, EXECUTE, @var = proc, bare names | `extract_sp_calls` |
| 5. UDF extraction | Inline scalar UDFs, false-positive guard | `extract_udf_calls` |
| 6. CTE exclusion | CTE names excluded from sources | CTE helper |
| 7. Extraction boundaries | Temp tables, variables, system objects, aliases | Regex (`\w+`), catalog resolution, `shouldSkip()` |
| 8. Combined SQL | Multi-rule interaction in realistic SP body | All rules |
| 9. Critical review | DELETE exclusion, OPENQUERY string protection | Design decisions |

### Key design principle

**False positives are harmless** — catalog resolution in `dacpacExtractor.ts` filters regex results against known dacpac objects. Only references matching real objects become graph edges. The tests therefore focus on:
- **No false negatives** (missed real dependencies)
- **Correct direction** (source vs target vs exec)
- **Preprocessing correctness** (strings/comments don't leak through)

## DMV Extractor Tests (`dmvExtractor.test.ts`)

Tests the database import model builder using synthetic DMV data:

| Section | What it validates |
|---------|-------------------|
| buildModelFromDmv | Node/edge/schema building from synthetic rows, shared helper integration |
| Empty Database | Warning generated for empty result sets |
| Column Validation | Required column contract enforcement, case-insensitive matching |
| formatColumnType | Type string formatting (varchar, nvarchar, decimal, int, etc.) |
| Duplicate Nodes | Deduplication by normalized ID |
| Self-Reference | Self-referencing deps excluded from edges |
| Fallback Body Direction | Unqualified table refs: WRITE if body has UPDATE/INSERT/MERGE/TRUNCATE near name, else READ |

## Type-Aware Direction Test

Proves that the fallback direction logic (used for XML-only deps) is correct:
- For every dep where **both** XML and regex agree, looks up the object type
- Infers direction: `procedure` -> EXEC (outbound), everything else -> READ (inbound)
- Compares with regex-determined direction (source=READ, target=WRITE, exec=EXEC)
- Table WRITEs are expected mismatches (handled by regex directly, excluded from fallback path)
- **100% match** on both classic and SDK-style dacpacs validates the fallback

## Test Dacpacs

| File | Type | Description |
|------|------|-------------|
| `AdventureWorks.dacpac` | Classic | Azure SQL Database (112 nodes, 116 edges, 6 schemas) |
| `AdventureWorks_sdk-style.dacpac` | SDK-style | Fabric Data Warehouse (69 objects, 21 SPs, 3 functions) |

Both produce the same artifact format (ZIP with `model.xml`). See `.claude/rules/test-data.md`.


## Shared Test Utilities (`testUtils.ts`)

All test files import shared helpers from `test/testUtils.ts`:

| Export | Purpose |
|--------|---------|
| `assert(condition, msg)` | Boolean assertion with pass/fail output |
| `assertEq(actual, expected, msg)` | Equality check with "expected X, got Y" on failure |
| `test(name, fn)` | Try/catch wrapper — catches exceptions as failures |
| `loadParseRules()` | Load parse rules from `assets/defaultParseRules.yaml` |
| `testPath(...segments)` | Resolve path relative to `test/` directory |
| `rootPath(...segments)` | Resolve path relative to project root |
| `printSummary(label?)` | Print results and exit with code 1 on failures |
| `makeGraph(nodes, edges)` | Build synthetic graphology graph for tests |
| `hasName(list, name)` | Case-insensitive partial match on list |

## Writing New Tests

1. Create a new `.test.ts` file in `test/`:
   ```typescript
   import { assert, assertEq, printSummary } from './testUtils';

   function testMyFeature() {
     console.log('\n── My Feature ──');
     assert(1 + 1 === 2, 'basic math works');
     assertEq(myFunction('input'), 'expected', 'returns correct output');
   }

   testMyFeature();
   printSummary('My Feature');
   ```

2. Add to the `test` script in `package.json` (chained with `&&`):
   ```json
   "test": "tsx test/existing.test.ts && tsx test/myFeature.test.ts"
   ```

3. Run your test: `npx tsx test/myFeature.test.ts`

4. Update test counts in this README and `.github/copilot-instructions.md`.

## Adding Tests

When modifying parse rules:
1. Run `npm test` before changes
2. Make your changes
3. Run `npm test` after — zero regressions allowed

## Internal Tests

For integration tests requiring a live SQL Server, see `test-internal/README.md`. These are gitignored and not part of `npm test`.

## Test Data Rules

Only AdventureWorks dacpacs allowed here. Customer data goes in `customer-data/` (gitignored). Customer identifiers must never appear in test files, code comments, or documentation.
