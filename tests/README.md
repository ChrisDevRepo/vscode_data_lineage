# Testing Framework

Multi-tier test infrastructure for the Data Lineage VS Code extension.

## Architecture

Tests are organized by environment requirement — what they need to run.

| Tier | Location | Runner | Requires | When |
|------|----------|--------|----------|------|
| **Unit** | `tests/unit/` | `tsx` (plain Node.js) | Nothing — pure logic | CI, pre-commit, local |
| **Integration** | `tests/integration/` | `tsx` | `.env` with SQL Server creds | Local only, skips without `.env` |
| **E2E + Eval** | `tests/e2e/` | `@vscode/test-electron` + Mocha | VS Code must NOT be running (test-electron claims mutex) | Local only, eval-loop skill |

## Folder Layout

```
tests/
├── README.md                              # This file
│
├── unit/                                  # Plain Node.js tests (CI-safe)
│   ├── dacpacExtractor.test.ts            # ZIP/XML extraction, filtering, edges
│   ├── graphBuilder.test.ts               # Graph construction, BFS trace
│   ├── graphAnalysis.test.ts              # Hub/island/cycle analysis
│   ├── parser-edge-cases.test.ts          # SQL parser regex edge cases
│   ├── tsql-complex.test.ts               # Real-world SQL patterns
│   ├── dmvExtractor.test.ts               # DMV → model building
│   ├── projectStore.test.ts               # Migration, serialization
│   ├── snapshot-aw-baseline.ts            # Parser regression baseline check
│   ├── ai-tools.test.ts                   # 184 AI tool pure-function tests
│   ├── column-trace-state.test.ts         # 98 CT state machine tests
│   ├── blackboard-state.test.ts           # 66 BB state machine tests
│   ├── bundle-sanity.js                   # Verifies out/extension.js loads
│   ├── helpers/testUtils.ts               # Shared assertions + dacpac loader
│   └── hooks/                             # React hook unit tests (vitest)
│
├── integration/                           # Live SQL Server tests (.env required)
│   ├── integration-db.test.ts             # 13 DB pipeline tests
│   └── helpers/dbAdapter.ts               # mssql adapter (creds from process.env)
│
├── e2e/                                   # Runs inside VS Code extension host
│   └── suite/
│       └── eval/                          # AI eval-loop (toolProxy + scorer)
│           ├── toolProxy.ts               # HTTP → vscode.lm.invokeTool() pass-through
│           └── eval.test.ts               # Mocha entry — starts proxy, waits for agents
│
├── fixtures/                              # Static test data (committed)
│   ├── AdventureWorks2025_AI.dacpac       # Primary — AW + [ai] schema (100 KB)
│   ├── AdventureWorks_sdk-style.dacpac    # SDK-style XML extraction (10 KB)
│   ├── aw-baseline.tsv                    # Parser snapshot baseline
│   └── sql/targeted/                      # 55 hand-crafted SQL parser fixtures
│
├── cases/                                 # Test case definitions (committed)
│   ├── README.md                          # Case format spec
│   ├── bb-*.md / bb-inline-*.md           # Blackboard SM tests (sliding / inline)
│   ├── ct-*.md / ct-inline-*.md           # Column trace SM tests
│   ├── dep-*.md / dep-inline-*.md         # Dependency trace (CT without columns)
│   ├── disc-*.md                          # Discovery (no SM — get_context, search_objects)
│   ├── perf-*.md                          # Performance/analysis (run_analysis)
│   ├── expl-*.md                          # SQL explanation (get_object_detail + DDL)
│   ├── doc-*.md                           # Documentation queries
│   └── follow-*.md                        # Multi-turn follow-ups
│

test-results/                              # Gitignored — all runtime output
├── eval-runs/run-YYYY-MM-DD-HH-MM/
│   ├── summary.md                         # Aggregate table: test | grade | SM | scope | hops | runtime | tokens
│   ├── summary.json                       # Machine-readable scoreboard
│   ├── prompts.json                       # Prompt snapshot at run time
│   ├── {test-id}.md                       # Per-test detail report
│   └── {test-id}.json                     # Full SM state + hopLog + scoring
├── archive/                               # Historical baselines (2026-04-13 reference runs)
├── sm-dumps/                              # JSON from dataLineageViz.dumpSmState command
└── workspace/                             # VS Code test workspace (used by test-electron)
```

## Running Tests

```bash
# Unit tests — no external dependencies
npm test                       # All unit tests (dacpac, graph, parser, project store, snapshot)
npm run test:unit              # Same as test
npm run test:unit:ai           # AI tool + SM unit tests (184 + 98 + 66 = 348 tests)
npm run test:snapshot          # Parser baseline regression check
npm run test:hooks             # React hook tests (vitest)

# Integration — live DB
npm run test:integration       # SQL Server pipeline tests (skips without .env)

# Extension host — no other VS Code running
npm run test:e2e               # Extension activation + command + tool smoke tests
npm run test:eval              # Starts tool proxy for eval-loop skill
```

## AI Eval-Loop (tool proxy architecture)

The eval-loop tests measure AI behavior quality — when prompts or SM logic change, did the agent still produce correct lineage analysis with acceptable runtime and token usage?

### Flow

```
User runs /eval-loop (Claude Code skill)
         │
    1. npm run test:eval
         │  starts @vscode/test-electron → activates extension → toolProxy on :3271
         │
    2. Skill spawns Agent(model: "haiku") per test case
         │
    Haiku Agent (Claude Code process) → POST /tool → toolProxy
         │
    vscode.lm.invokeTool() → REAL toolProvider.ts → REAL SM → REAL session
         │
    tool result → back to agent → loop until done
         │
    3. Skill fetches GET /session/:id/state → sess.stateMachine.toJSON()
         │   (complete SM data: narrative, detailSlots, visited, removed, scope)
         │
    4. scorer reads case MD, compares expected vs actual, writes report
```

### Why this works (vs old HTTP bridge)

The proxy's `/tool` handler is a 6-line pass-through to `vscode.lm.invokeTool()`. **Zero tool routing duplication** — no more `dispatcher.ts` drift.

```typescript
const { name, input } = toolCallSchema.parse(body);
const result = await vscode.lm.invokeTool(name, {
  input, toolInvocationToken: undefined as any
}, new vscode.CancellationTokenSource().token);
const text = (result.content[0] as vscode.LanguageModelTextPart).value;
res.end(JSON.stringify({ result: JSON.parse(text), _meta: { tool: name, durationMs, tokens } }));
```

When `toolProvider.ts` changes, proxy needs zero updates.

### Proxy Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Model stats, project name |
| `GET /tools` | List registered lineage tool names |
| `GET /prompts` | System + BB/CT mode prompts + tool descriptions (real extension functions) |
| `POST /session` | Reset session, return fresh sessionId |
| `POST /filter` | `{ schemas[], types[] }` — set user filter |
| `POST /tool` | `{ tool, input, sessionId? }` → `{ result, _meta }` pass-through |
| `GET /session/:id/state` | Full SM state: `toJSON()` + hopLog with timing/tokens + resultGraph |
| `DELETE /session/:id` | Clear session state |
| `POST /shutdown` | Graceful exit (writes signal file, exits) |

### Manual proxy control

```bash
# Start (foreground — stays alive until signal)
EVAL_WAIT=1 EVAL_SIGNAL_DIR="$PWD/test-results" \
  npx vscode-test --files out/test/tests/e2e/suite/eval/eval.test.js

# Shutdown (choose one)
curl -X POST http://127.0.0.1:3271/shutdown
# OR
echo > test-results/eval-done.signal
```

## Test Case Format

Each case in `tests/cases/*.md` follows a fixed structure. See [cases/README.md](./cases/README.md) for full spec.

**Key sections:**
1. **Question** — the user's natural-language question
2. **Classification** — type, persona, difficulty, dacpac, origin, direction, columns, filter
3. **Expected Outcome** — SM type, delivery mode, scope, max hops, runtime budget, token budget, rejection limits
4. **Fact Check** — ground-truth measurements verified via proxy
5. **Required Nodes / Forbidden Nodes** — correctness assertions
6. **Optimal Path** — ideal agent behavior

The `Expected Outcome` table is the authoritative spec. The scorer enforces it on every run.

## Test Suite (21 cases)

| Category | Count | Delivery |
|----------|-------|----------|
| Discovery / no-SM | 5 | classic (no SM) |
| BB inline (scope ≤ 10) | 3 | inline batch |
| BB sliding (scope > 10) | 3 | hop-by-hop with sliding memory |
| CT columns inline | 2 | inline batch |
| CT columns sliding | 2 | hop-by-hop with sliding memory |
| CT deps inline | 1 | inline |
| CT deps sliding | 2 | hop-by-hop |
| Multi-turn follow-up | 3 | session reuse, add/prune nodes, active-SM guard |

## Dacpac Fixtures

Two committed dacpacs cover all test scenarios:

| Dacpac | Purpose |
|--------|---------|
| `AdventureWorks2025_AI.dacpac` (100 KB) | Primary — AdventureWorks schemas + `[ai]` schema with synthetic pipeline (FactSalesReport, SAPOrders, OracleOrders, etc.) |
| `AdventureWorks_sdk-style.dacpac` (10 KB) | Tests SDK-style XML extraction path (different structure from classic) |

No customer data committed. Environment-specific DB dacpacs (for live DB parity testing) stay in `.env`-gated locations.

## Related Documentation

- `.claude/skills/eval-loop/SKILL.md` — full eval-loop skill workflow (invoked via `/eval-loop`)
- `.claude/rules/ai.md` — AI chat participant architecture rules
- `docs/AI_ARCHITECTURE.md` — public technical spec of SM + memory tiers
- `docs/AI_PROMPTS.md` — user-facing prompt customization guide
