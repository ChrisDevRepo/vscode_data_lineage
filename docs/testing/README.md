# Testing

## Default Checks

```sh
npm ci
npm test                    # deterministic unit tests
npm run test:core           # parser, engine and webview
npm run test:runtime        # AI runtime contracts, without inference
npm run gate                # configured deterministic checks
```

Focused parser and graph checks are `npm run test:parser` and `npm run test:bfs`. TypeScript checks are `npm run typecheck` and `npm run typecheck:tests`. The repository has no lint script.

The gate summary marks a step `SKIP` when it could not run its comparison; a skipped step is not verified. The output template schema version step compares against the newest `v*` tag, or `origin/main` when no tag exists, and skips locally when neither is present. With `CI` set it fails instead, so a CI checkout must fetch tags or `origin/main` (for example `actions/checkout` with `fetch-depth: 0`).

Targeted contract regressions (no database or model calls):

```sh
npm test -- tests/unit/sm/function-question-schema.test.ts tests/unit/sm/fresh-kept-schema-parity.test.ts
npm test -- tests/unit/parser/identifier-case.test.ts tests/unit/sm/identifier-policy-saved-run.test.ts tests/unit/ai-core/identifier-runtime-flow.test.ts tests/unit/engine/columnTraceView.test.ts
```

The first covers function caller context and findings-schema parity; the second covers identifier-case policy. The runtime fixture uses the real tool registry with a fixed-response model port; it does not measure whether an inference model follows a hint. A structurally valid delivered graph does not establish complete SQL lineage.

## Build And Install A VSIX

Build the extension package from the repository root:

```sh
npm ci
npm run package
```

This creates `data-lineage-viz-<version>.vsix` in the repository root; install it with `code --install-extension ./data-lineage-viz-<version>.vsix` in a separate VS Code profile. Packaging does not publish.

## Optional Integration Checks

Machine prerequisites for each tier: [Test Environments](ENVIRONMENTS.md).

`npm test` and `npm run gate` require no database, model provider, tracing account, or graphical session.

| Check | Setup | Purpose and limit |
|---|---|---|
| Database metadata smoke | Configure `DB_TEST_SERVER`, `DB_TEST_DATABASE`, `DB_TEST_USER`, `DB_TEST_PASSWORD`, optional TLS/port settings; run `npm run test:db:smoke`. | SQL-login connection, schema discovery and metadata import through the built-in provider. Read-only queries against your disposable/demo database; no provisioning. For Microsoft Entra ID and mssql-extension saved profiles, verify the selected provider manually in the extension host. |
| Electron host | `npm run test:edh` | Exercises extension behavior in the VS Code Electron host. The fixture-backed participant lane is deterministic API wiring, with no model inference. |
| Playwright UI smoke | Run `npm run build`, then `npm run test:gui:host`; in another terminal, run `npm run test:gui:smoke`. | Uses an isolated downloaded VS Code test host, opens the demo through the command palette and confirms a React Flow graph renders in the workbench. |
| UI performance | Use the same EDH/CDP setup with a fixed public demo dataset and a named device/runtime. | Manual measurement: record warm/cold state, dataset size, repetitions, median and p95. Results describe that setup only; do not use one-machine timings as general thresholds. |
| Real-model Electron smoke | Configure `AI_TEST_PROVIDER`, `AI_TEST_ENDPOINT`, `AI_TEST_API_KEY`, `AI_TEST_MODEL`, and optionally `AI_TEST_REASONING_EFFORT`; run `npm run test:ai:smoke`. Provider profiles cover Azure OpenAI, Fireworks, OpenRouter and OpenAI-compatible APIs. | Calls a real model through a `vscode.LanguageModelChatProvider` adapter and the `@lineage` participant against the public demo DACPAC. It checks that the turn completes and returns text; review answer correctness and completeness against SQL/graph yourself. This smoke is opt-in and may incur provider cost. |

## Optional Headless AI And Langfuse

```sh
npm run test:ai:headless -- --prompt "Summarize the loaded database"
npm run test:ai:headless -- --dacpac /path/to/test.dacpac --prompt "Trace dependencies" --followup "Explain the upstream objects"
npm run test:ai:headless -- --prompt "Summarize the loaded database" --langfuse
npm run test:ai:headless -- --help
npm run test:ai:headless -- --prompt "Summarize the loaded database" --langfuse --label Q1 --session eval-1 --tag arm:candidate
npm run test:db:smoke -- --help
npm run test:scale
```

Headless AI loads `assets/demo.dacpac` by default and runs the production runtime in Node with an OpenAI-compatible transport and the same `AI_TEST_*` profiles as the Electron smoke. Consent gates receive simulated approvals, so it does not check interactive consent or VS Code provider behavior. Completion is not answer-correctness evidence.

The whole-run deadline is 30 minutes (a `/trace` turn takes 7–14 minutes); database smoke has five. Override with `--timeout-ms` (1–7,200,000); the AI deadline is also each model request's deadline. Connection-phase failures are retried up to three attempts. Output goes under ignored `test-results/headless/`; `run.json` reports outcome, duration, call counts and export outcome. Exit codes: 0 completed, 2 runtime/export failure, 3 cancelled, 4 configuration.

**Langfuse** (`--langfuse`, needs all three `LANGFUSE_*` settings; OTLP/HTTP JSON, no SDK; 30-second export timeout). `--label ID` names the trace, `--session ID` groups runs, each `--tag TEXT` adds a trace tag. Each tool call is a `tool` observation (rejection = `WARNING` with code and field paths, thrown handler = `ERROR`); the trace carries counts of calls, rejections, gates and dispatch errors. Tool arguments and results and prompt/system bodies are not exported unless `--trace-verbose`. `--attach` (requires `--langfuse`) also uploads the run's evidence files (trace, debug log, answers, hop logs, state dumps) with literal API keys removed and files above 50 MB skipped; these can contain database metadata, so use it only with a trusted backend and public or synthetic data.

`test:scale` exercises layout correctness at the 1,500-node render ceiling. It is deliberately outside `npm test` and `gate`; printed timings describe this run and are not performance thresholds. Fast size-limit and traversal assertions remain in the default suite.

## Prompt Screening Cost Ladder

A prompt or template edit climbs these tiers in order and stops at the first tier that rejects it. Every candidate variant goes through tier 1 first; only a variant that passes tier 1 is sent to the target provider, and tier 2 then runs the fewest arms needed to promote or reject it. Each tier compares an unchanged control arm with the edit arm under the same configuration. Report pass counts per arm (for example 4/5 against 1/5); never report medians or one sample.

A reply passes when it is correct for the question and the served instructions, not only for the SQL: it states the facts the SQL supports, stays inside the requested scope, depth and direction, gives the requested answer form, leaves out what the user excluded, and follows the output contract. Read each reply against that checklist; a keyword match is a pointer to the sentence to read, never a score.

| Tier | Cost | What it shows |
|---|---|---|
| 0. Deterministic tests | None | `npm test` and the prompt/template checks in `.agents/skills/prompt-change/SKILL.md`. Wiring, schema and rendering only; no model behavior. |
| 1. Small-model screening (default first step; the vendor's cheapest model, simulating the run only) | Low, no target-provider call | Instruction clarity, contradictions and gross failures; drops variants before tier 2. Its pass counts are **not** evidence of target-model behavior. |
| 2. Stage replay on the target provider | About 1–2% of a full run per sample | N samples per arm of one recorded stage request with the edit applied, on fixture **and** held-out inputs. This is the tier that promotes a change. |
| 3. Full run | Full turn | One full headless run per affected question per arm, to confirm the tier-2 result end to end. |

All tiers use one tool, `node tests/tools/stage-replay.mjs` (`--help` lists every option). It reads an lm-trace NDJSON recorded by `npm run test:ai:headless -- --trace-verbose`. Results go only under ignored `test-results/` (a directory outside the repository is also accepted); never commit traces, bundles or replies.

```sh
# List recorded generations: request id, generation, phase, focus node, request size
node tests/tools/stage-replay.mjs find --trace TRACE.ndjson [--needle "text in a message"]
# Check that every substitution hits, without sending
node tests/tools/stage-replay.mjs replay --trace TRACE.ndjson --generation 4 --subs edit.json --dry-run
# Tier 2: N samples per arm against the recorded provider URL
node tests/tools/stage-replay.mjs replay --trace TRACE.ndjson --generation 4 --samples 5 --arm control
node tests/tools/stage-replay.mjs replay --trace TRACE.ndjson --generation 4 --subs edit.json --samples 5 --arm edit
```

`edit.json` is a JSON array of exact `{"old": "...", "new": "..."}` substitutions applied, in order, to message contents. Tool definitions are not changed. If any `old` text does not occur, nothing is sent or exported, so an edit that no longer matches the current wording cannot be measured silently. Generation numbers restart in every turn; a multi-turn trace needs `--request-id` (a prefix is enough). Replay posts the recorded body to the recorded HTTPS URL, collapses the doubled `/chat/completions` suffix of older traces, adds `AI_TEST_REASONING_EFFORT` when the recorded body has no effort (as the headless runner does when sending), and retries 429/502/503/504. The key comes from `AI_TEST_API_KEY` or the selected provider profile and uses the `api-key` header for `azure`; it is never printed or written, and Bearer tokens in error bodies are redacted. Each sample writes one JSON file with the request summary, substitution hit counts, status, attempts, latency, usage and response body. Exit codes are 0 when every sample returned 2xx, 2 when one did not, and 4 when the replay was refused.

### Running tier 1 blind

**Purpose of the screening model.** Tier 1 uses a small, cheap model only to simulate the AI run: it answers the served request so that format errors, contradictions and gross failures are found before any target-provider call is paid for. It is never used to grade answers, analyse traces or write code; those use the agent harness's default full-size model. The screening model is the cheapest model offered by the vendor of the agent harness (a mini- or flash-class model). Only the role is fixed, not the vendor. The target provider for tier 2, tier 3 and every new baseline is the model configured in `AI_TEST_MODEL`. The repository runs no screening model itself, so the agent harness makes the call. The screening model must be as blind as the target provider: it sees the served messages and tools and nothing else.

1. Export a bundle per arm: `node tests/tools/stage-replay.mjs replay --trace TRACE.ndjson --generation 4 --subs edit.json --export test-results/screen/edit`. No provider is called. It writes:
   - `system.md`: the served system message, byte for byte;
   - `user.md`: every later message in served order with roles, tool calls and results, then each tool's name, description and JSON parameter schema, ending in a fixed instruction to reply with one `{"tool": ..., "arguments": {...}}` object;
   - `prompt.md`: the same with the system message included, for a reader;
   - `request.json`: the substituted payload, no auth data;
   - `bundle.json`: trace, generation, focus node, substitutions, the served `model` and the `reasoningEffort` a replay sends.
2. Make one blind call per sample: `system.md` is the screening model's system prompt and `user.md` its single user turn, at the bundle's `reasoningEffort` where the vendor supports one. Use the harness vendor's single-call mode: cheapest model, no tools, no project instructions or memory, one turn, system text taken verbatim from `system.md`, started from an empty fixed directory. The call has no tools, no file or repository access, no project instructions, memory or settings, runs from an empty working directory, and is one turn. Tier 1 only counts replies made this way. An agent subagent that reads the bundle with file tools is not blind (it carries its own system prompt, project instructions and tools). Save the reply verbatim to a file, one file per sample. Never continue one conversation across samples or arms: a later sample would see the earlier replies.
3. Check each reply: `node tests/tools/stage-replay.mjs check test-results/screen/edit REPLY.txt --out test-results/screen/edit/check-1.json`. It accepts a fenced `json` block, requires a tool from the bundle and validates the arguments against that tool's schema. `check.json` holds `{valid, errors[], tool, arguments}`, so grading scripts read it like a provider reply. Exit code 0 is a valid reply, 2 an invalid one.

Tier 1 screens instruction clarity, contradictions and gross failures only. A small model that passes says nothing about the target model, and one that fails may be weaker than the target. Promote a change only on tier-2 pass counts from the target provider on fixture and held-out inputs. Before relying on tier 1 for a class of edits, calibrate it: compare its pass counts with tier-2 pass counts on an edit whose tier-2 result is already known. A small model that does not share the target model's weakness passes the control arm as well, so tier 1 can reject a variant (an invalid reply, a contradiction, a fact the control got right and the variant gets wrong) but cannot show that an edit fixes a target-model weakness; only tier 2 shows that.

### Payload metrics of recorded runs

`node tests/tools/trace-metrics.mjs TRACE.ndjson [TRACE.ndjson ...]` reads lm-trace files and prints, per run, every `lineage_submit_findings` call with its outcome, the columns it named as value inputs and as row roles, the nodes it pruned, a prune of a node the same call names as a source, entries without `writes_to` (meaningful for procedure hops only), the rejections by code, a `repair` block, and the captured snippets synthesis was offered against the ones the report cites. With several traces of one question it compares the accepted hops per focus object and lists the columns that appear in only some runs. A different set between repeated runs is a contract defect, not noise. It shows what a hop sent, not whether that was right: the SQL and the fact ledger decide that. Deterministic contract tests for it are in `tests/tools/trace-metrics.test.mjs`.

The `repair` block follows every rejected call to the call that repaired it: the chains per focus object with the number of rejections before the accepted resend (a histogram of repairs on the first, second, third, later retry or never), and per rejection the output tokens of the rejected reply against the resent reply, the characters of both calls, and the top-level fields the resend carried beyond the offending fields and the call identity (`focus_node_id`, `verdict`, `is_update`). A resend is defect-only when it carries no such extra field and is at most half the size of the rejected call. This is expected only of a large exchange (a rejected call of at least 4,000 characters); a small tool call is resent whole and raises nothing. Sizes are characters of the call input, tokens are reported beside them, and tokens include reasoning, so compare arms by the same measure.

The same tool applies generic rules and reports two kinds of finding, never a score:

- **Defects** are technical faults of the pipeline that a trace shows without reading the answer. Each states the correct behavior. A defect blocks a push until its root cause is fixed in the owning layer (`AGENTS.md`).
- **Signals** say an answer may be incomplete or wrong. A signal proves nothing: it states what to verify, and it is verified by reasoning on the question and the SQL before it is called a fault.

`--fail-on-defect` exits 1 when any defect is found, so a recorded run set can be checked in a script. Defects come first in the output. The rules describe symptoms, never fixture objects, and their thresholds are fixed in the tool before any run is read.

| Rule | Kind | Correct behavior, or what to verify |
|---|---|---|
| `run_not_completed` | defect | A turn ends with outcome `ok` or a stated stop reason; accepted work is not discarded by a transient fault |
| `repair_unresolved` | defect | A rejected call is followed by an accepted resend, or the run ends with a stated stop reason |
| `same_field_rejected_twice` | defect | A rejection names the field so that the next resend corrects it; one field is not rejected twice in a row |
| `prune_names_source` | defect | A node that supplies a column of the trace does not leave the graph without a trace in the report |
| `source_set_differs_between_runs`, `row_role_set_differs_between_runs` | defect | Repeated runs of one question name the same value inputs and row-role contributors per object |
| `trace_misaligned` | defect | Every dispatched call has one tool record, so every outcome can be read |
| `repair_needed_several_retries` | signal | Was the rejection text clear, or did the model misread it? |
| `resend_not_defect_only` | signal | Only for a rejected call of at least 4,000 characters: its resend carried more than half of it, or fields the rejection did not name. Did that content change? A small call is resent whole without a finding |
| `snippet_citations_collapsed`, `snippet_citations_differ_between_runs` | signal | Does the report still show the deciding SQL of each formula and predicate, or only prose about it? |
| `row_role_contributors_not_kept` | signal | Does the report state each row rule (filter, partition or order key) that decides which rows feed the value? |
| `rejection_answered_not_resent` | signal | Is the text answer a correct decline for the question? |
| `writes_to_rejected`, `discovery_budget_rejected` | signal | Could the extra call have been avoided from the tool text? |

## Environment Template

Copy `.env.example` to `.env`; `.env` is ignored by Git. Fill only the section for the optional check being run. Do not paste secrets into shell history or test logs.

Choose one provider profile per run; the adapter uses Chat Completions. Azure: give the resource URL (the adapter adds the deployment route and `api-version=2024-10-21`) or an `/openai/v1` endpoint, and `AI_TEST_MODEL` is the deployment name. Otherwise set `AI_TEST_PROVIDER` to `azure`, `fireworks`, `openrouter` or `openai-compatible` and provide that profile's variables in `.env` or the process environment — `AZURE_URI`/`AZURE_API`/`AZURE_MODEL`, `FIREWORKS_URL`/`FIREWORKS_API`/`FIREWORKS_MODEL`, `OPENROUTER_URL`/`OPENROUTER_API`/`OPENROUTER_MODEL`, or `AI_TEST_OPENAI_COMPATIBLE_ENDPOINT`/`_API_KEY`/`_MODEL` — which fill only canonical `AI_TEST_*` values that are empty. Keep credentials in the ignored `.env`. Leave `AI_TEST_REASONING_EFFORT` empty when the provider does not support it.

For Playwright, start the host:

```sh
npm run build
npm run test:gui:host
```

Then run the smoke from another terminal:

```sh
npm run test:gui:smoke
```

`test:gui:host` uses the VS Code build managed by `@vscode/test-electron`, fresh temporary workspace, user-data and extensions directories, and a loopback-only CDP endpoint. It writes an ignored active-session marker that the smoke validates before attaching, so the smoke does not connect to a normal VS Code instance. Stop the host with Ctrl-C after the smoke finishes.

## Reading AI Evidence

Compare AI answers with the public fixture's SQL and graph before comparing token usage or latency. For debugging, inspect the model context, tool calls and results in the session trace and extension log. See [AI architecture](../ARCHITECTURE.md) for the runtime and diagnostics.

## Keeping The Suite Lean

Public checks protect deterministic product contracts; prompt scoring, trace-replay corpora and benchmark campaigns stay local. Before deleting or merging a test, identify the retained assertion that protects its behavior, including failure cases. Prefer shared fixtures or parameterized cases. Preserve parser cases, input identity, cancellation, trust boundaries, persistence, accessibility and packaging. Coverage floors are supporting evidence, not an answer-quality score. The warm default-suite review budget is 30 seconds on the reference machine. Optional services and large layouts stay outside the default gate.

For approval controls, pending chat input and next-question badges, run the opt-in [native chat Playwright acceptance lanes](../EDH_TESTING.md#native-chat-and-generated-report-acceptance-playwright). Run the fixture lane for request lifecycle and the live lane for the actual follow-up badge and generated reply. The fast `npx vscode-test --config .vscode-test.chat-ui.mjs --label badge` lane replays a successful public analysis for setup and makes one live call after clicking the actual badge; it does not prove fresh synthesis. Verify contextual formulas separately with headless production AI and direct inspection of the generated Markdown and fresh NDJSON, using the same public DACPAC, model and original question; this does not prove rendered webview layout. A synthetic answer or a direct call to `handleChatRequest` cannot establish end-to-end UI or model correctness. Repeat these CLI commands using the same saved approval prefix instead of constructing a new shell command for each attempt.
