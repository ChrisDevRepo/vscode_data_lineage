# Copilot Instructions

How this extension is built, so an AI assistant can reason about it before
changing it. Tracked source, tests, and documentation are the authoritative
context; this file explains the parts the code alone does not reveal — why a
boundary exists, which component owns a decision, and what a given design
choice is protecting.

## Read First
- `docs/ARCHITECTURE.md`: runtime architecture, graph contracts, `NavigationEngine`
- `docs/DEVELOPER_GUIDE.md`: extension, ingestion, and runtime-evidence workflows
- `docs/AI_PROMPTS.md`: `@lineage` prompt/tool/template lifecycle
- `docs/EDH_TESTING.md`: unit gate, Electron smoke lanes
- `docs/PARSE_RULES.md` and `docs/DMV_QUERIES.md`: parser and DMV customization
- `docs/PROFILING_PATTERNS.md`: generated profiling SQL, its settings, and its limits
- `docs/FEATURES.md` and `docs/TROUBLESHOOTING.md`: user-facing behaviour and diagnostics
- `CONTRIBUTING.md` and the `package.json` scripts: toolchain versions and the command set

## What the extension is

`data-lineage-viz` reads SQL objects — tables, views, procedures, functions —
from a DACPAC file or from live SQL Server, Azure SQL, Fabric, or Synapse
metadata, resolves them into a dependency graph, and renders that graph as an
interactive diagram. It ships two bundles: the extension host (esbuild →
`out/extension.js`) and a React webview (Vite → `dist/`). Everything crossing
that boundary travels as a discriminated union declared in `bridgeContract.ts`
and is Zod-parsed on both sides, which is why there is no untyped `postMessage`
anywhere — a message that does not parse is a bug caught at the seam rather
than a render failure deep in the webview.

An optional `@lineage` chat participant answers questions about the graph.

## The AI surface

`src/ai/participant/lineageParticipant.ts` is the only AI entry point. There is
no embedded chat webview and no separate AI panel, so a feature that needs AI
attaches to the participant rather than opening a second surface.

The model path is fixed: participant → `LineageRuntime` → LangGraph →
`VscodeModelPort` → `VscodeLangChainBridge` → `vscode.lm`. The model is exactly
`ChatRequest.model`, passed straight through. That single decision is what
gives the extension the user's Copilot model — including their "Manage Models…"
BYOK configuration — for free, and it is why the extension holds no API keys,
no provider setting, and no endpoint configuration. Selecting or substituting a
model would break that inheritance rather than extend it.

`vscode.lm` has no system role, so `VscodeLangChainBridge` downgrades a
`SystemMessage` to a User turn. Anything that depends on system-role semantics
has to survive that mapping. Copilot Chat also prepends its own `system`
message to every request (content policy, "keep answers short", Markdown,
KaTeX `$`/`$$`, mermaid code blocks); the extension's depth and "never draw
diagrams" rules must therefore be explicit in its own instruction text — they
cannot rely on being the only instructions the model sees.

Tool calls run through the local strict-Zod dispatcher, not
`vscode.lm.invokeTool`. The bridge preserves tool-selection semantics across the
two type systems: LangChain `any` is VS Code `Required`, `none` sends no tools,
and a named choice exposes only that tool. Unsupported choices and missing
tool-call IDs fail before model dispatch, where the diagnosis is still cheap.
The `package.json` `languageModelTools` manifest is generated from the Zod
schemas and a drift test guards the pair.

An AI-authored view carries its run forward. `present_result` stamps the run id
onto the view metadata and, once the presentation commits, captures the engine
checkpoint onto the session artifact; the capture is try/catch-guarded and
observed at debug, so it can never fail an answer the model already earned. The
user's bookmark save is what persists it: the record is written to `globalState`
under `dataLineageViz.aiRun.<bookmarkId>` only when the profile is AI-authored
and its run id matches the captured presentation, and a failed or oversized
write logs a warning while the bookmark save itself stays successful. Deleting
the bookmark clears the record. `lineage_get_screen_state` is the only reader
and is read-only; the record is read tolerantly, so an absent, older, or
foreign-shaped one answers `no_run_memory` rather than failing the call.

## How a turn runs

The participant stays thin. The outer LangGraph owns discovery, semantic
retries, gates, hop-by-hop transitions, synthesis, and terminal ownership — so
turn state lives in the graph, and the language model acts as a semantic worker
rather than a process-state owner.

`ChatContext.history` is the production conversation source. Only ordered
user/assistant text and complete tool-call/result pairs convert; an orphan tool
message would be rejected by the provider, so the conversion never invents one.
An empty native history is the explicit new-chat boundary: it cancels an old
gate, rotates the session ID, and runs `AiSession.resetExploration()`.

Active exploration begins only through the approve-gate path, and
`activatePendingExploration` is the single site that publishes a navigation
engine. Every mutating or panel-presenting tool call runs under the active turn
lease — including calls arriving through externally registered `vscode.lm` tools
from Copilot agent mode, not only through the internal dispatcher.

Within one phase the retry context re-projects accepted observations and the
newest rejection. An accepted call retires every earlier rejection of the same
tool, and a resend byte-identical to a read accepted in an earlier attempt is
answered with an uncharged `duplicate_read` envelope naming the accepted call —
a silent replay left the model with no response to act on and it repeated the
call until the provider-call stop.

`NavigationEngine` owns BFS scope, agenda, gates, route validation, pruning,
closure, and termination. Bounding traversal in the engine rather than in the
prompt is deliberate: a schema, state machine, or code guard holds where a
prompt-only constraint drifts.

Depth follows that rule and splits on who chose it. A level count the model
reports as stated by the user (`depthIntent.kind` of `explicit` or `asymmetric`)
is a **hard border**: the engine refuses admission past it, per direction, and
records the frontier through the same `deferQuestion` path a schema breach uses.
A depth the model inferred (`default_start`) stays a **soft seed** the model may
grow, exactly as before. Which of the two applies is the model's semantic call,
carried as Zod-validated `depth` — the host never parses the user's text for it —
and the engine, never the prompt, enforces the result.

That split generalizes past depth. Every scope rule reaching the engine is either **hard** —
the user stated it — or **soft** — the model chose it as a starting point; the model
classifies which, as a typed field, and the host never reads the user's sentence to decide.
The approval card is grouped by that classification, so a limit the user set and one the
model estimated are never rendered as the same kind of fact, and an estimate carries `≈`.
Once approved, the plan is what runs: the engine is constructed from the approved `init`
object itself, and `checkBorder` enforces the result at every admission purpose. The one
thing the engine cannot bind is an instruction that maps to no filter field — it rides along
as `scopeNotes` for the model to honour, with nothing to reject a breach.

## Prompts, presentation, and rejection

Every stage that calls `lineage_present_result` composes its system prompt
through the shared phase dispatcher (`buildPhasePrompt`) and receives
`buildPresentationDetailContract`. One validator judges preview and synthesis
alike, so a rule given to one stage and not the other surfaces as a rejection
the model could not have avoided — a prompt-composition defect, not a model
defect. Stage-specific text stays with its stage; everything else belongs in the
shared builder.

`assets/aiOutputTemplates.yaml` owns *what* an answer contains and *when* a
template block applies — the user-overridable layer. Code-owned prompt text and
tool `.describe()` strings own *how* the model operates the mechanism (which
field carries which template, which phase allows which call). Never move a
content rule or threshold out of the YAML into `prompts.ts` or a schema
description; a description may reference the template entry, never restate it.
Contract: `docs/AI_PROMPTS.md` §Source of truth.

`validatePresentResult` is the single rejection point. Checks that need context
the validator does not hold — a cached discovery answer, the result graph — pass
their findings into its accumulator instead of returning early, because
reordering checks only changes which defect stays hidden. A rejection names the
offending entry paths, not just the rule: each defect class disclosed on its own
round costs its own semantic-failure charge against a budget of three.

Repair is minimal-delta. A rejected submission is held and repaired through
bounded correction fragments and the strict patch schema rather than re-sending
the whole payload.

## Persisted records

The project store lives in `globalState` and is validated on read. Validation
tolerates fields it does not recognise rather than discarding the record: a
record written by an older build carries keys this one never declared, and
rejecting it would be silent user-data loss. The write path selects
schema-declared keys instead of removing known-bad ones, so nothing undeclared
is persisted in the first place.

## Provenance and live SQL

`DatabaseModel.source` carries the ingestion lane, stamped by each extractor,
and `buildModel` stays lane-agnostic. `dbPlatform` is not a proxy for it: a
DACPAC derives a platform label from its DSP exactly as a live import derives
one from the server, so the presence of a platform says nothing about where the
model came from.

Every SQL statement sent to a real database is documented in
`docs/DMV_QUERIES.md` and overridable through the user's `dmvQueries.yaml`, so a
change to live-database SQL ships those updates in the same commit. The AI
dependency closure is snapshot-only — it cannot connect, execute SQL, refresh
data, start DMV ingestion, or start profiling.

## LangSmith containment

LangSmith is a transitive dependency of `@langchain/core`, never an application
dependency. Four layers keep it inert: an npm `overrides` entry redirecting
`langsmith` to the empty shell in `stubs/langsmith/`, a fail-closed tracing
guard that trips before any graph or model call, the `assert-no-langsmith` gate
step, and a pin on `@langchain/core`.

The pin exists for a specific reason. From 1.2.8 that package vendors
`src/utils/gateway.ts`, which rewrites a model call's `baseURL` to a LangSmith
gateway when `LANGSMITH_GATEWAY` or `LANGSMITH_GATEWAY_API_KEY` is set. The npm
override cannot reach that code — it lives inside `@langchain/core`, not in the
`langsmith` package — and the runtime guard watches different variables than the
gateway reads, so only the bundle-signature gate catches it. An outdated-
dependency report is not a reason to unpin. `@langchain/langgraph` is unaffected
and may advance on its own.

Trace export is Langfuse-only. A test-only REST exporter is the sanctioned
exception: plain HTTP from dev-box test tooling, no vendor SDK, no tracing
flags, never bundled.

## Diagnostics and logging

AI diagnostic logging is off by default and enabled only through an explicit
session-scoped command, so there is no always-on content-bearing AI log.

Lifecycle records carry enumerated codes, counters, and dotted field paths —
never prompts, model text, tool payloads, or error prose. A turn still has to be
diagnosable from the trace alone within that constraint, which is why the stop
reason and the offending paths are recorded and the prose stays in the log.

Logging goes through `src/utils/log.ts`, and user-facing errors and warnings
through `notifyError` / `notifyWarning` (`src/utils/notifications.ts`) so full
detail and stack reach the Output channel at the same level as the toast;
webview errors funnel through the bridge `'error'` message. Severity follows
meaning: AI and Zod rejections are normal AI behaviour and log at `debug`, while
a render-limit or node-cap is capacity guidance at `info`.

## Conventions

Doc comments follow TSDoc: `/** */` contracts on exported API, with
`@param name - description`, `@returns`, `@throws`, `@remarks` for invariants,
and `@internal` for non-public exports. In `.ts`/`.tsx` types live in signatures
and are not repeated in comments; plain `.mjs` scripts keep type-bearing JSDoc
because that is the only place the type can be stated. Comments carry contracts,
not narration, decision history, or notes to a reviewer.

Commands and settings use the `dataLineageViz.*` prefix, and the schema
expansion view is named `Expanded Schema View`. Changelog notes go under the
current version heading; the project uses no `[Unreleased]` section and the
version number is the user's to set.

The LangGraph runtime is the established architecture, and current tracked
source and tests are the implementation baseline.

## Testing

`npm run gate` is the deterministic pre-merge check; `CONTRIBUTING.md` and the
`package.json` scripts list the command set. Beyond type-checking, builds, and the
unit suites it enforces six derived contracts: the
`contributes.languageModelTools` manifest drift check, the AI template
schema-version gate, the honest-test-label scan, the unit-project coverage check
that makes the two unit steps add up to the whole suite, the packaged-VSIX
contents check, and the `assert-no-langsmith` bundle check.

`npm run test:edh` runs the extended VS Code Electron lanes outside the gate,
against a scripted provider registered through the real `vscode.lm` API — it
proves extension wiring, not model behaviour. The lanes are serial: they share
one Electron profile and one `out/` build, so exactly one host runs at a time and
`.vscode-test.mjs` is never edited to parallelize them. The failure modes that
edit produces, and why the serial cost is not worth engineering around, are in
`docs/EDH_TESTING.md` §One host at a time.

The host and the model are tested on separate surfaces, and that separation is a
decision rather than a gap. A host is the only place `activate()`, contribution
points, command registration, and `vscode.lm.invokeTool` exist, so it is the only
place their defects can surface; everything it adds beyond that is deterministic
translation that does not care whether the text came from inference. Model
behaviour is measured internally, headless, never through this repository's
tracked suite, and the Electron fixture stays scripted-only — it must not grow a
live-provider mode. `tests/unit/ai-core/helpers/portContract.ts` is a
port-agnostic acceptance suite proving the real `vscode.lm` transport
(`VscodeModelPort`) satisfies the model-port contract; a new guarantee about that
boundary belongs in that suite, never in a credentialed host lane.

The suites prove the deterministic core: SQL parsing and dependency extraction,
graph construction and traversal, schemas, and state transitions. How good a
model's answer is cannot be settled by a repository test and is not measured
here.

Live database access is UAT-only and outside the automated framework. No runner
connects to a server, so DMV query execution, `{{SCHEMAS}}` expansion against a
real catalog, result shapes, platform detection, and custom `dmvQueriesFile`
loading are verified by hand — their absence from the suite is the design, not a
gap. Model building from DMV-shaped data is a different thing and stays covered
by `tests/unit/parser/dmvExtractor.test.ts` over synthetic result sets.

Tests are Vitest `describe`/`it`; the unit suite applies the `vscode` stub alias
globally. There is no snapshot tier: after editing `assets/defaultParseRules.yaml`
a green `npm run test:parser` is not evidence that parser output is unchanged,
so the resulting dependency edges are reviewed against the DDL by hand.

## Security and data handling

Secrets, customer data, proprietary DACPACs, and raw traces do not belong in the
repository; only approved AdventureWorks DACPAC fixtures are committed under
`tests/fixtures/`.

Default runtime logs are content-free. Session diagnostics, once explicitly
enabled, may contain prompts, customer data, tool payloads, and provider
responses — they stay in ignored storage and are reviewed before sharing, and
credentials and authorization headers are never recorded.

Dynamic prompt slots — hop context, tool observations, the user question —
escape `<`/`>` and carry an untrusted-data banner; `src/ai/agent/toolAttempt.ts`
and `stagePrompts.ts` hold the established idiom for a new slot.

Third-party prompt sources contribute concepts, not prose. Copying licensed
prompt or template text near-verbatim requires a tracked third-party-notices
register recording source, license, destination, and modifications.
