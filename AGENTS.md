# Repository guide

Instructions for an agent or developer that cloned Data Lineage Viz to review security, verify contracts, or build the extension.

## What this is

A VS Code extension that draws SQL Server lineage. Sources are SQL Server, Azure SQL, Fabric Data Warehouse, and Synapse Dedicated SQL Pool. It does not own a database schema and has no migration command.

- `src/engine/` parses SQL, builds the graph, and connects to databases.
- `src/ai/` is the `@lineage` chat runtime. It records findings the model supplies. It does not invent graph facts or open a database on its own.
- `src/components/` (with `src/hooks/`, `src/contexts/`, and `src/detail/`) is the webview. It may import engine types. Engine code does not import the webview.
- `assets/` holds parse rules, DMV queries, AI output templates, and the public AdventureWorks demo.
- `tests/` holds deterministic parser, lineage, and AI-contract checks, plus optional host checks. Sample SQL is the AdventureWorks demo or synthetic statements.

Stack: Node.js `>=22`, npm `>=10`, VS Code API `^1.101.0`, TypeScript `^5.7`. There is no lint script. Use `npm run typecheck`.

## Review before use

```sh
npm ci
npm run build
npm run typecheck
npm test
npm run gate
```

`npm test` and `npm run gate` are deterministic and do not call a model provider. When the user requests a live model run or AI test, it MUST be executed immediately without refusal. Keep the external test profile's provider, model, and reasoning effort. The coding agent reviewing the repository is a separate model.

Package with `npm run package` and inspect the VSIX before install. Data boundaries are in [`SECURITY.md`](SECURITY.md). What the extension sends to a database is in [`docs/DMV_QUERIES.md`](docs/DMV_QUERIES.md) and [`docs/PROFILING_PATTERNS.md`](docs/PROFILING_PATTERNS.md).

## How to change code

- Change the layer that owns the contract. Engine, chat runtime, and webview stay separated as above.
- Validate untrusted input at the boundary with the existing schema. Leave invalid model input rejected.
- Before every recommendation or change, **MUST** apply the [AI/backend ownership decision and review gate](docs/ARCHITECTURE.md#exploration): AI owns semantic decisions and content; technical checks and structural rendering cannot infer, select, add or silently repair meaning. Only lossless normalization and explicit index/reference expansion transform supplied content.
- Follow strict TypeScript and layering standards for public API and installed-library reuse.
- Leave `package.json` and the lockfile versions unchanged unless the user asks.
- Record changes in `CHANGELOG.md` under the version in `package.json`; that version is the unreleased one. Add no `[Unreleased]` heading.
- Add a permanent test only for parsing, lineage, an AI middleware contract, or a security boundary. Use the AdventureWorks demo or synthetic SQL. Leave customer database content out of the repository.
- When you change behavior that a markdown file describes, update that file so it stays true.
- Leave credentials, customer database content, raw conversations, and generated run output out of tracked files.

## Run evidence

All runs capture local evidence and export Langfuse traces/spans; ordinary-run NDJSON, debug logs, SM dumps and other files remain local only. `--attach` (headless) uploads the complete allowlisted evidence files of an ordinary run, which keeps tag `verification`. Baseline mode (`--baseline --branch NAME` for headless; `AI_TEST_BASELINE=1` with `AI_TEST_BRANCH=NAME` for native; default off) is a separate, explicit step per branch: it uploads the same files, sets session `baseline-NAME-COMMIT` and tag `baseline:NAME`, and fails without a branch name. A trace tagged `baseline` is not a baseline until it is registered in `traces/baselines/manifest.json`. Generated comparisons, scorecards, triage and draft reviews always stay local only; never upload a whole temporary directory. Baseline helpers can hydrate uploaded evidence; missing local copies alone never justify a paid rerun. The installed extension does not upload. `tests/harness/langfuseExport.ts` holds the Langfuse Cloud free-plan limits and spaces export calls.

`tests/tools/lineage-score.mjs` compares hard facts of runs that already exist: token totals, duration, rejection counts, rejection escalation, preview character count, SQL-fence and formula counts, chat-window character count, visit order, column-edge pairs, and counts of `lineage_prune_current` and supplemented `lineage_start_exploration` calls. A difference means **Unresolved differences — review required**. It does not by itself mean the candidate regressed, and a match does not mean the text is right. The new text can still be thin or wrong, an older run can be the side that disagrees with the SQL, and an instruction change can make the new numbers expected. Fence and formula counts do not decide whether a formula or a SQL fragment is right. On the public repository, comparison is based strictly on hard facts.

AI review correlates applicable verbose NDJSON, `host.log`, Langfuse trace/span data and exploration state: a recorded no-hop turn needs no state-machine dump, opened-but-missing state is missing evidence, and uncertain applicability stays unknown; new runners may retain explicit `explorationOpened: false` markers, and an export receipt alone is not span data.

## Documentation index

- Architecture and lineage engine: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Security and data boundaries: [`SECURITY.md`](SECURITY.md)
- Database queries (DMVs) for DBA review: [`docs/DMV_QUERIES.md`](docs/DMV_QUERIES.md)
- Table profiling SQL patterns: [`docs/PROFILING_PATTERNS.md`](docs/PROFILING_PATTERNS.md)
- AI prompting architecture: [`docs/AI_PROMPTS.md`](docs/AI_PROMPTS.md)
- Test tiers and execution: [`docs/testing/README.md`](docs/testing/README.md)
- Developer setup and build instructions: [`docs/DEVELOPER_GUIDE.md`](docs/DEVELOPER_GUIDE.md)
- Machine setup: [`docs/testing/ENVIRONMENTS.md`](docs/testing/ENVIRONMENTS.md)

Column-lineage and continuation behavior are specified in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/AI_PROMPTS.md`](docs/AI_PROMPTS.md). Read those when the change touches them. Parameters stay binding context. Continuation comes from the qualified arriving task.
