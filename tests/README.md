# Testing Framework

Multi-tier test infrastructure for the Data Lineage VS Code extension. Tests are organized by environment requirement.

| Tier | Location | Runner | Requires | When |
|------|----------|--------|----------|------|
| **Unit** | `tests/unit/` | `tsx` (plain Node.js) | Nothing — pure logic | CI, pre-commit, local |
| **Integration** | `tests/integration/` | `tsx` | `.env` with SQL Server creds | Local only, skips without `.env` |
| **E2E + Eval** | `tests/e2e/` | `@vscode/test-electron` + Mocha | VS Code must NOT be running | Local only |

## Folder layout

```
tests/
├── README.md                              # This file
│
├── unit/                                  # Plain Node.js tests (CI-safe)
│   ├── dacpacExtractor.test.ts            # ZIP/XML extraction, filtering, edges
│   ├── graphBuilder.test.ts               # Graph construction, BFS trace
│   ├── graphAnalysis.test.ts              # Hub / island / cycle analysis
│   ├── parser-edge-cases.test.ts          # SQL parser regex edge cases
│   ├── tsql-complex.test.ts               # Real-world SQL patterns
│   ├── dmvExtractor.test.ts               # DMV → model building
│   ├── projectStore.test.ts               # Migration, serialization
│   ├── snapshot-aw-baseline.ts            # Parser regression baseline
│   ├── ai-tools.test.ts                   # AI tool pure-function tests
│   ├── ai-tool-registration.test.ts       # manifest ↔ registration guard
│   ├── navigation-engine.test.ts          # NavigationEngine lifecycle + memory
│   ├── navigation-engine-cascade.test.ts  # Cascade-prune guard for irrelevant verdict
│   ├── bundle-sanity.js                   # Verifies out/extension.js loads
│   ├── helpers/testUtils.ts               # Shared assertions + dacpac loader
│   └── hooks/                             # React hook unit tests (vitest)
│
├── integration/                           # Live SQL Server tests (.env required)
│   ├── integration-db.test.ts             # DB pipeline tests
│   └── helpers/dbAdapter.ts               # mssql adapter (creds from process.env)
│
├── e2e/                                   # Runs inside VS Code extension host
│   └── suite/eval/
│       ├── toolProxy.ts                   # HTTP → vscode.lm.invokeTool pass-through
│       └── eval.test.ts                   # Mocha entry — starts proxy, waits for agents
│
├── fixtures/                              # Static test data (committed)
│   ├── AdventureWorks2025_AI.dacpac       # Primary — AW + [ai] schema
│   ├── AdventureWorks_sdk-style.dacpac    # SDK-style XML extraction path
│   ├── aw-baseline.tsv                    # Parser snapshot baseline
│   └── sql/targeted/                      # Hand-crafted SQL parser fixtures
│
├── cases/                                 # Eval test case definitions
│   ├── README.md                          # Case format spec
│   ├── EVAL-RUBRIC.md                     # Output-quality grading framework
│   ├── bb-*.md / bb-inline-*.md           # Blackboard exploration cases
│   ├── ct-*.md / ct-inline-*.md           # Column trace cases
│   ├── dep-*.md / dep-inline-*.md         # Dependency trace cases
│   ├── disc-*.md                          # Discovery (no SM) cases
│   ├── perf-*.md                          # Performance / analysis cases
│   ├── expl-*.md                          # SQL explanation cases
│   ├── doc-*.md                           # Documentation cases
│   └── follow-*.md                        # Multi-turn follow-up cases
```

Runtime output (gitignored): `test-results/` — eval runs, SM dumps, VS Code test workspace.

## Running tests

```bash
# Unit — no external dependencies
npm test                    # Full unit suite (dacpac, graph, parser, project store, snapshot, tool registration)
npm run test:unit:ai        # AI tool + NavigationEngine + cascade-prune tests
npm run test:snapshot       # Parser baseline regression check
npm run test:hooks          # React hook tests (vitest)

# Integration — live SQL Server (requires .env)
npm run test:integration    # DB pipeline tests (skips gracefully without .env)

# Extension host — no other VS Code running
npm run test:e2e            # Extension activation + command smoke tests
npm run test:eval           # Starts tool proxy for AI eval agents
```

## Connecting your own AI agent for evaluation

`npm run test:eval` starts a local HTTP proxy on port 3271 that exposes the extension's registered language-model tools via REST. Any AI agent — OpenAI, Anthropic, local model via Ollama, a custom Python script — can POST tool calls and receive real results from the running extension.

**Minimal integration:**

```bash
# Start the proxy (leaves VS Code extension host running)
npm run test:eval &

# Your agent POSTs tool calls:
curl -X POST http://127.0.0.1:3271/tool \
  -H "Content-Type: application/json" \
  -d '{"tool": "lineage_search_objects", "input": {"query": "Employee"}, "sessionId": "my-agent-001"}'

# Your agent reads the resulting SM state:
curl http://127.0.0.1:3271/session/my-agent-001/state
```

Each `/tool` POST flows through `vscode.lm.invokeTool` — hitting the real tool provider, state machine, and session. The proxy is a thin pass-through with no logic of its own, so extension changes apply automatically.

**Health & introspection endpoints:** `GET /health`, `GET /tools`, `GET /prompts?sessionId=...`. See `tests/e2e/suite/eval/toolProxy.ts` for the full request / response shapes.

**Grading:** agent outputs can be scored against the rubric in [cases/EVAL-RUBRIC.md](./cases/EVAL-RUBRIC.md) — output-quality-first (Correctness / Completeness / Question-Answering / Type-Appropriate Detail), 12 points total.

## Test case format

Each file under `tests/cases/*.md` follows a fixed structure. See [cases/README.md](./cases/README.md) for the spec and [cases/EVAL-RUBRIC.md](./cases/EVAL-RUBRIC.md) for the grading rubric.

**Required sections:**
1. **Question** — the user's natural-language question
2. **Classification** — type (`bb`/`ct`/`disc`/`perf`/`doc`/`expl`/`follow`), persona, difficulty, dacpac, origin, direction, columns, filter
3. **Expected Outcome** — SM type, delivery mode, scope range, max hops, runtime / token budgets, rejection limits
4. **Fact Check** — ground-truth measurements verified against the actual dacpac
5. **Required / Forbidden Nodes** — correctness assertions
6. **Optimal Path** — ideal agent behavior

The `Expected Outcome` table is the authoritative spec. Grading follows the rubric in `EVAL-RUBRIC.md` — output-quality-first (Correctness / Completeness / Question-Answering / Type-Appropriate Detail), 12 points total, with a memory-quality pre-gate.

## Dacpac fixtures

Two committed dacpacs cover all eval scenarios:

| Dacpac | Purpose |
|--------|---------|
| `AdventureWorks2025_AI.dacpac` | Primary — AdventureWorks schemas + `[ai]` schema with synthetic pipeline (FactSalesReport, SAPOrders, OracleOrders, etc.) |
| `AdventureWorks_sdk-style.dacpac` | SDK-style XML extraction path (structurally different from classic) |

No customer or proprietary data is committed. Environment-specific dacpacs stay outside the repo.

## Related documentation

- `docs/AI_PROMPT_ARCHITECTURE.md` — what belongs in system / navigation / synthesis prompts (with expert citations)
- `docs/AI_ARCHITECTURE.md` — unified NavigationEngine + two-tier memory technical spec
- `docs/AI_PROMPTS.md` — user-facing prompt customization guide
- `tests/cases/EVAL-RUBRIC.md` — grading rubric + anti-overfitting discipline
