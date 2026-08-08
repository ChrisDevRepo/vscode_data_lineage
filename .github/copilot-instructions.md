# Copilot Instructions

These instructions and `CONTRIBUTING.md` are the public development policy for
this repository. Use tracked source, tests, and documentation as the only
authoritative context.

## Read First
- `docs/ARCHITECTURE.md`: runtime architecture, graph contracts, `NavigationEngine`
- `docs/DEVELOPER_GUIDE.md`: extension, ingestion, and runtime-evidence workflows
- `docs/AI_PROMPTS.md`: `@lineage` prompt/tool/template lifecycle
- `docs/E2E_TESTING.md`: maintained local unit gate and optional AI-backend check
- `docs/PARSE_RULES.md` and `docs/DMV_QUERIES.md`: parser and DMV customization
- `docs/FEATURES.md` and `docs/TROUBLESHOOTING.md`: user-facing behaviour and diagnostics

## Core Engineering Rules
- The main-first LangGraph runtime is the established architecture, not an
  in-progress donor migration. Current tracked source and tests are the
  implementation baseline; do not recreate historical migration or recovery
  work without a current reproducer and an explicit scope decision.
- `@lineage` (`src/ai/participant/lineageParticipant.ts`) is the **only** AI surface.
  There is no embedded chat webview and no separate AI panel.
- The model path is fixed and has no configuration: participant → `LineageRuntime`
  → LangGraph → `VscodeModelPort` → `VscodeLangChainBridge` → `vscode.lm`.
- Pass exactly `ChatRequest.model`; never select, replace, configure, or fall back
  to another model. The extension has no API keys, no provider setting, and no
  endpoint configuration — the user's chosen Copilot model is the model.
- Treat `ChatContext.history` as the production conversation source. Convert only
  ordered user/assistant text and complete tool-call/result pairs; never invent an
  orphan tool message or add a second participant-owned history store.
- An empty native history is the explicit new-chat boundary. Cancel an old gate,
  rotate the session ID, and call the established `AiSession.resetExploration()`
  path. Do not replace or reimplement `AiMemoryManager`, and do not change a
  selected model's `maxInputTokens`.
- Keep the participant thin. The outer LangGraph owns discovery, semantic
  retries, gates, hop-by-hop transitions, synthesis, and terminal ownership.
- Route model tool calls through the local bridge and canonical strict-Zod
  dispatcher. Never route production `@lineage` calls through
  `vscode.lm.invokeTool`.
- Preserve tool-selection semantics at the bridge: LangChain `any` is VS Code
  `Required`, `none` sends no tools, and named choices expose only that tool.
  Unsupported choices and missing tool-call IDs fail before model dispatch.
- Do not add LangSmith clients, configuration, keys, callbacks, or direct
  dependencies. The transitive `langsmith` dependency of `@langchain/core` is
  redirected to the inert local stub in `stubs/langsmith/` via the root npm
  override — never remove that override or the `assert-no-langsmith` gate
  check. Ambient LangChain/LangSmith tracing must fail closed before any
  graph or model call; prompts and graph state must not leave the extension.
  The test-only REST exporters under `tests/harness/` (`langfuseExport.ts`,
  `langsmithExport.ts`) are the sanctioned exception: plain HTTP from dev-box
  test tooling, no SDK, no tracing flags, never bundled.
- `NavigationEngine` owns BFS scope, agenda, gates, route validation, pruning, closure, and termination.
- Treat the language model as a semantic worker, not a process-state owner.
- AI diagnostic logging is disabled by default and may be enabled only through
  the explicit session-scoped command. Do not introduce an always-on
  content-bearing AI log or a persistent setting for it.
- Keep the AI dependency closure snapshot-only. It cannot connect, execute SQL,
  refresh data, start DMV ingestion, or start profiling.
- Model provenance is carried by `DatabaseModel.source`, stamped by each
  extractor; `buildModel` stays lane-agnostic. Never infer the ingestion lane
  from other metadata. `dbPlatform` is not a proxy — a DACPAC derives a platform
  label from its DSP exactly as a live import derives one from the server, so
  presence of a platform says nothing about provenance.
- Validate untrusted boundaries with Zod.
- Persisted records are read back through a `.strict()` schema and discarded when
  they fail, so the write path must select schema-declared keys rather than
  remove known-bad ones. A deny-list lets an external object's extra fields into
  storage that the read side then rejects — silent user-data loss. Narrow at the
  write site; never loosen the read schema to accommodate it.
- Prefer schema/FSM/policy/code guards over prompt-only constraints.
- A rule enforced by a shared validator must be stated to every stage that
  validator judges. Stages compose their system prompt through the shared phase
  dispatcher (`buildPhasePrompt`) and the shared presentation contract; never
  hand-roll a stage's protocol block at the call site. A stage rejected for a
  rule only another stage was given is a prompt-composition defect, not a model
  defect.
- One submission produces one complete rejection. Checks needing context a
  validator does not hold pass their findings into its accumulator instead of
  rejecting early; ordering checks to decide which defect surfaces first only
  changes which one stays hidden. Rejections name the offending entry paths, not
  just the rule — each defect class disclosed on its own round costs its own
  semantic-failure charge, and the budget is three.
- Diagnostic lifecycle records carry enumerated codes, counters, and dotted
  field paths — never prompt, model text, tool payloads, or error prose. A turn
  must stay diagnosable from the trace alone within that constraint: record the
  stop reason and the offending paths, and leave the prose in the log.
- Use `src/utils/log.ts` helpers only.
- Every user-facing error/warning notification must go through `notifyError` / `notifyWarning` (`src/utils/notifications.ts`) so full detail + stack reach the Output channel at the same level as the toast — never demote detail to `debug`. Webview errors funnel through the bridge `'error'` message.
- AI/Zod rejections are normal AI behavior → `debug`, not error/warn. Render-limit / node-cap reached is capacity guidance → `info`, not an error.
- Use `dataLineageViz.*` for commands and settings.
- Use `Expanded Schema View` naming for the schema expansion view.
- The user solely owns the version number. Never bump/lower or restructure versioning, and never add a CHANGELOG `[Unreleased]` section (the project does not use one); new notes go under the current version heading.

## Testing And Verification
- Tests run locally before push; GitHub workflows do not run the test suite.
- `npm run gate` is the deterministic client-side gate. It includes production
  and test type-checking, the Core and AI unit suites, both builds, integration
  test compilation, and package checks.
- `npm test` runs every unit test. `npm run test:core` owns parser and non-AI
  engine coverage; `npm run test:ai` owns AI-core and state-machine coverage.
  `test:parser` and `test:bfs` are focused Core shortcuts, not extra test kinds.
- `npm run test:e2e` is the optional extended VS Code Electron suite. Its five
  labels (including the T1-T7 `scenario-matrix` lane) remain available for
  focused reruns and are not part of the gate.
- `npm run test:e2e-real` is the headless real-model lane runner
  (`tests/harness/`, dev-box only): the production pipeline against an
  OpenAI-compatible provider, credentials only in the gitignored `.env`,
  self-skipping without them, never part of the gate or any workflow. Its
  Langfuse/LangSmith exporters are pure REST test tooling — they must never
  introduce a vendor SDK dependency or tracing environment flags.
- Write tests as Vitest `describe`/`it`. The unit suite applies the `vscode`
  stub alias globally.
- There is no snapshot tier and no `test:snapshot` script. After editing
  `assets/defaultParseRules.yaml`, run `npm run test:parser` and review the
  resulting dependency edges against the DDL by hand — a green run is not
  evidence that parser output is unchanged.

## Security
- Never commit secrets, customer data, proprietary DACPACs, raw traces, or
  locally excluded files.
- Treat every path excluded by `.gitignore` as private. Public documentation
  must not name, quote, link to, or depend on excluded content.
- Only approved AdventureWorks DACPAC fixtures may be committed under `tests/fixtures/`.
- Default runtime logs must remain content-free. Explicitly enabled session
  diagnostics are private and may contain prompts, customer data, tool payloads,
  and provider responses; keep them in ignored storage, never commit them, and
  review them before sharing. Credentials and authorization headers must never
  be recorded.
- Dynamic prompt slots (hop context, tool observations, user question) must
  escape `<`/`>` and carry an untrusted-data banner; follow the established
  idiom in `src/ai/agent/toolAttempt.ts` / `stagePrompts.ts` for any new slot.
- Third-party prompt sources: reuse concepts, not prose. If licensed prompt or
  template text is ever copied near-verbatim, create a tracked
  third-party-notices register (source, license, destination, modifications)
  before merge.
