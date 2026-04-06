# Test Suite

## Running Tests

```bash
npm test                                       # All unit tests (1372 tsx + 112 vitest + snapshot)
npx tsx test/dacpacExtractor.test.ts           # Dacpac extractor tests (109 tests)
npx tsx test/graphBuilder.test.ts              # Graph builder + trace tests (218 tests)
npx tsx test/parser-edge-cases.test.ts         # Syntactic parser tests (204 tests)
npx tsx test/graphAnalysis.test.ts             # Graph analysis tests (81 tests)
npx tsx test/dmvExtractor.test.ts              # DMV extractor tests (193 tests)
npx tsx test/tsql-complex.test.ts              # SQL pattern tests (55 tests)
npx tsx test/projectStore.test.ts              # Project store tests (136 tests)
npx tsx test/ai-tools.test.ts                  # AI tool function tests (184 tests)
npx tsx test/column-trace-state.test.ts        # Column-trace state machine tests (98 tests)
npx tsx test/blackboard-state.test.ts          # Blackboard state machine tests (66 tests)
npx tsx test/chat-loop.test.ts                 # Chat-loop orchestration tests (28 tests)
npx vitest run --config vitest.config.ts       # Hook tests (112 tests, vitest + React Testing Library)
npm run test:snapshot                          # Parser baseline check (31 AW SPs vs committed TSV)
npm run test:snapshot:update                   # Regenerate test/aw-baseline.tsv after parser changes
npm run test:coverage                          # Hook tests with v8 coverage report
```

## Test Files

| File | Tests | Purpose |
|------|-------|---------|
| `dacpacExtractor.test.ts` | 109 | Dacpac extraction, filtering, edge integrity, Fabric SDK, CVE security, error handling, constraint extraction (UQ/CK/FK), `parseDspPlatform`, `dbPlatform`, `pkOrdinal`, Phase 1→2 bridge flow |
| `graphBuilder.test.ts` | 218 | Graph construction, dagre layout, BFS trace, directional edge filtering, cycle filtering, bidirectional correctness, determinism, virtual external nodes, CLR method suppression, buildSchemaEdges, buildSchemaGraph |
| `parser-edge-cases.test.ts` | 204 | **Syntactic parser tests** — pure regex rule verification, no dacpac data |
| `graphAnalysis.test.ts` | 81 | Graph analysis: islands, hubs, orphans, longest path, cycles, external refs |
| `dmvExtractor.test.ts` | 193 | DMV extractor: synthetic data, column validation, type formatting, fallback body direction, constraints, external tables, schema placeholder expansion, `dbPlatform` via `mapEnginePlatform`, `pkOrdinal` from columns query |
| `tsql-complex.test.ts` | 55 | **SQL pattern tests** — targeted SQL files covering each parser pattern; expected results embedded as `-- EXPECT` comments |
| `projectStore.test.ts` | 136 | Project store: createProject, updateProject, deleteProject, migrateProjectStore, generateProjectName, addFilterProfile, deleteFilterProfile, serializeFilter, deserializeFilter |
| `ai-tools.test.ts` | 184 | AI tool pure functions: getContext, searchObjects (schemas/types/regex/mismatch), getObjectDetail, runBfsTrace (ddl/schema/type filters, truncation), runAnalysis, searchDdl, getDdlBatch, validateEnrichView, autoFixEnrichView, validateQuery, safeRegex, validateMarkdownFormat |
| `column-trace-state.test.ts` | 98 | Column-trace state machine: lifecycle, init, verdict processing, rejection/retry, column validation, frontier cap, boundary detection, synthetic model tests, bug regression (diamond merge, passthrough visited, depth tracking, focus boundary) |
| `blackboard-state.test.ts` | 66 | Blackboard state machine: lifecycle, findings, two-tier memory, Self-Ask questions, agenda priority, prune cascade, coverage tracking, boundary detection, edge cases |
| `chat-loop.test.ts` | 28 | Orchestration loop: classic tool dispatch, dedup, CT multi-hop, round limit, BB tool visibility. Uses fake Copilot responses via `chatLoopTestHarness.ts` |
| `hooks/useInteractiveTrace.test.ts` | 31 | **Trace state machine** — mode transitions (none/configuring/filtered/applied/pathfinding/path-applied/analysis), depth limits (upstream-only, downstream-only), path finding success/failure, analysis subset, endTrace/clearTrace reset from all modes, tracedNodes memoization |
| `hooks/useGraphology.test.ts` | 27 | **Graph filter pipeline** — schema filter (case-insensitive), type filter, isolation (hideIsolated), exclusion patterns, focus schema + cross-schema neighbors, allowlist, external ref visibility, graph/metrics state, rebuild behavior |
| `hooks/useDacpacLoader.routing.test.tsx` | 30 | useDacpacLoader: message routing (dacpac vs DB paths), state transitions, callbacks, isDemo flag |
| `hooks/CreateFlow.save.test.tsx` | 3 | CreateFlow: save-project passes DacpacConnection to onVisualize |
| `hooks/App.save.test.tsx` | 3 | App-level save-project routing |
| `snapshot-aw-baseline.ts` | — | **Parser regression baseline** — diffs all 31 AW SPs against committed `test/aw-baseline.tsv` (see `npm run test:snapshot`) |

## Dacpac Extractor Tests (`dacpacExtractor.test.ts`)

Tests the dacpac import pipeline end-to-end, covering both classic (Azure SQL) and SDK-style (Fabric DW) dacpacs:

| Section | What it validates |
|---------|-------------------|
| DACPAC Extraction | Node/edge counts, schemas, object types from classic dacpac |
| Schema Filtering | Schema filter + max node cap |
| Edge Integrity | No dangling edges, no self-loops, no duplicates |
| Fabric SDK Dacpac | Views/tables/procs/functions counts, QueryDependencies, BodyDependencies |
| Security: CVE-2026-25128 | Out-of-range numeric entity handling in fast-xml-parser v5 |
| Import Error Handling | Non-ZIP, empty file, missing model.xml, empty dacpac warnings |
| Constraints | UQ/CK column flags and FK section in table design view; SDK-style dacpac shows "(none)" |

## Graph Builder Tests (`graphBuilder.test.ts`)

Tests graph construction and the BFS trace engine:

| Section | What it validates |
|---------|-------------------|
| Graph Builder | Layout, positions, metrics, trace reachability |
| Trace: No Siblings | BFS trace includes all edges between traced nodes (leveled + unlimited + upstream-only) |
| Trace: Bidirectional BFS | Bidirectional nodes don't block traversal, depth-limited, determinism (50 runs) |
| Synapse Dacpac: Trace | Real SDK-style dacpac trace with phantom edge validation |

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

**False positives are harmless** — catalog resolution in `modelBuilder.ts` filters regex results against known dacpac objects. Only references matching real objects become graph edges. The tests therefore focus on:
- **No false negatives** (missed real dependencies)
- **Correct direction** (source vs target vs exec)
- **Preprocessing correctness** (strings/comments don't leak through)

## DMV Extractor Tests (`dmvExtractor.test.ts`)

Tests the database import model builder using synthetic DMV data:

| Section | What it validates |
|---------|-------------------|
| buildModelFromDmv | Node/edge/schema building from synthetic rows, empty DB, duplicate dedup, self-reference exclusion |
| Column Validation | Required column contract enforcement, case-insensitive matching |
| formatColumnType | Type string formatting (varchar, nvarchar, decimal, int, etc.) |
| Fallback Body Direction | Unqualified table refs: WRITE if body has UPDATE/INSERT/MERGE/TRUNCATE near name, else READ |

## Test Dacpacs

| File | Type | Description |
|------|------|-------------|
| `AdventureWorks.dacpac` | Classic | Azure SQL Database (112 nodes, 117 edges, 6 schemas) |
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

### tsx tests (engine / pure functions)

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

2. Add to the `test` script in `package.json` (chained with `&&`) before the `tsx test/snapshot-aw-baseline.ts` step:
   ```json
   "test": "... && tsx test/myFeature.test.ts && tsx test/snapshot-aw-baseline.ts && vitest run ..."
   ```

3. Run your test: `npx tsx test/myFeature.test.ts`

### vitest tests (React hooks / components)

Create a `.test.ts` or `.test.tsx` file in `test/hooks/` and use standard vitest + React Testing Library:
```typescript
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect } from 'vitest';

describe('My hook', () => {
  it('does something', () => {
    const { result } = renderHook(() => useMyHook());
    act(() => { result.current.doSomething(); });
    expect(result.current.state).toBe('expected');
  });
});
```

Vitest picks up `test/hooks/**/*.test.ts[x]` automatically — no changes to `package.json` needed.

4. Update test counts in this README and `.github/copilot-instructions.md`.

## Adding Tests

When modifying parse rules:
1. Run `npm test` before changes (captures current snapshot state)
2. Make your changes
3. Run `npm test` after — zero regressions allowed
4. If the snapshot diff shows new detections (improvements, not regressions), run `npm run test:snapshot:update` to accept them

## Internal Tests

For integration tests requiring a live SQL Server, see `test-internal/README.md`. These are gitignored and not part of `npm test`.

## Test Data Rules

Only AdventureWorks dacpacs allowed here. Customer data goes in `customer-data/` (gitignored). Customer identifiers must never appear in test files, code comments, or documentation.
