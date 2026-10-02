# AI Prompting And Templates

This document describes the durable prompt/customization contract for
`@lineage`. The tracked TypeScript builders, tool schemas, policy, and tests are
the source of truth for exact wording and provider-visible shapes.

## Source of truth

- [`assets/aiOutputTemplates.yaml`](../assets/aiOutputTemplates.yaml) contains
  the editable output-template instructions.
- [`src/ai/prompting/`](../src/ai/prompting/) owns phase prompts, SM guidance,
  template routing, and completion-envelope rendering.
- [`src/ai/agent/stagePrompts.ts`](../src/ai/agent/stagePrompts.ts) assembles
  discovery, active, and synthesis instructions;
  [`src/ai/agent/instructionPlan.ts`](../src/ai/agent/instructionPlan.ts)
  compiles one model generation with its phase-valid tools.
- [`src/ai/tools/toolSchemas.ts`](../src/ai/tools/toolSchemas.ts),
  [`src/ai/tools/toolPolicy.ts`](../src/ai/tools/toolPolicy.ts), and
  [`src/ai/tools/toolProvider.ts`](../src/ai/tools/toolProvider.ts) own tool
  shapes, phase availability, strict validation, and dispatch.
- [`src/ai/tools/presentResult.ts`](../src/ai/tools/presentResult.ts) validates
  and deterministically assembles the final presentation.
- [`src/ai/tools/toolDefs.ts`](../src/ai/tools/toolDefs.ts) is the single tool
  catalog. `package.json` `languageModelTools` is the generated read-effect
  subset; chat commands stay in `package.json`.

YAML is a customization layer, not the whole prompt. Phase instructions and
mechanical enforcement remain code-owned.

The shared base prompt derives identifier comparison from checked model metadata.
For CS catalogs it tells every authoring stage to retain the exact object IDs and
column names returned by tools; case-only variants identify different endpoints.
CI keeps its existing prompt and normalization. The hint supports model authoring;
shared backend resolvers and route validation enforce identity independently of it.

Templates own answer content and style; code owns phase routing, tool
availability, and mechanical field contracts. An overlay changes instructions,
not validation or scope rules.

Soft length targets live in the applicable template or field description.
Hard caps are declared in [`toolSchemas.ts`](../src/ai/tools/toolSchemas.ts)
and exposed as JSON Schema constraints. `present_result` enforces them at
schema parsing; `submit_findings` content caps are enforced by
`NavigationEngine` against a repairable held draft. Prose fields such as
`summary`, `intro`, and `closing` have no hard length cap.

## Tool catalog

Two surfaces consume `TOOL_DEFS`. A name that exists on one does not imply it
exists on the other.

**Registered with `vscode.lm`** (`effect: 'read'` only — Copilot agent mode and
`#lineage_*` references): `lineage_get_context`, `lineage_get_screen_state`,
`lineage_search_objects`, `lineage_get_object_detail`, `lineage_search_ddl`,
`lineage_detect_graph_patterns`, `lineage_get_neighbor_columns`.

**Participant-internal** (in-process dispatcher only; never
`vscode.lm.registerTool`): `lineage_get_scope_bundle` (discovery `scope_store`),
`lineage_start_exploration` (consent gate), `lineage_submit_findings` (hop
commit), `lineage_present_result` (presentation commit).

Phase availability is [`src/ai/tools/toolPolicy.ts`](../src/ai/tools/toolPolicy.ts).
Active exploration exposes `lineage_submit_findings` and
`lineage_get_neighbor_columns` together; neighbor-column inspection is for
opaque focus DDL (`SELECT *`, dynamic SQL, ambiguous joins), not a second
catalog search.

`compileInstructionPlan` uses Required tool mode when only the terminal tool
is exposed (synthesis and preview), and Auto for the two-tool active hop.
The graph independently enforces `requiredTerminalTool` and retries a
text-only generation when a tool call is required.

## Assembly and memory contract

The participant does not build prompts or own a tool loop. The outer graph
selects the stage, the stage builders assemble the instruction, and the model
bridge sends it to the exact `ChatRequest.model` selected by VS Code.

- Discovery and completed follow-ups can use the retained provider-neutral
  conversation. The completed follow-up prompt states what that context
  actually holds: the archive and rendered result graph are not replayed,
  detail is re-derived through the phase-valid read tools, and a presentation
  update replaces the section list wholesale — an omitted section is a deleted
  section, while a section listed under its committed label without text keeps
  its body and cited SQL blocks.
- The discovery-summary compose round runs under its own system prompt:
  every memo clause must come from the supplied question and discovery answer,
  plain prose, authored for later hops rather than for the user. The memo
  carries the user's original question near-verbatim, the headline discovery
  finding, and any user-stated semantic constraint the structural scope fields
  cannot express (for example "trace X but do not analyze column Y"); the
  already-locked contract is never restated into it. The round fires only when
  a discovery question and answer both exist — a direct trace command has no
  discovery answer to summarize, so those sessions carry user intent through
  the verbatim `<original_question>` block and the AI-authored mission brief
  alone, while the engine re-supplies structural facts fresh every hop.
- Active exploration keeps a stable system prefix (protocol, stage block,
  mission brief, escaped canonical `<original_question>`, and discovery
  summary) and sends focus, task, capture recipe, escaped hop context, recent
  summaries, and rejection guidance in a bounded per-hop message. The thread is
  reseeded to one continuation anchor at approval and after every committed hop,
  so no hop — the first included — carries the participant history or a prior
  hop's tool payloads. The canonical question is resolved at `start_exploration` from
  user-authored text (verbatim discovery prompt, then the current turn's
  prompt) before the model-supplied paraphrase.
- Function investigations with explicit `questions[].caller_context` re-supply the relevant caller SQL
  with each function investigation, tied to validated qualified caller targets.
  A reseeded hop cannot rely on the earlier caller's DDL remaining in the thread.
  The model reads invocation arguments and distinguishes value production from
  row selection in that SQL; object dependency alone does not establish a column
  contribution. `caller_requested_outputs` carries requested qualified outputs;
  `caller_objects` carries re-derived SQL. These requests remain separate from
  established scalar `caller_output_targets`; the declaration itself creates no
  edge. Identity validation and retention of submitted edges do not establish
  that the model identified every SQL contributor or row-selection dependency.
- Per-hop memory is tiered so repeated hops stay flat in size: recent hop
  summaries ride in a fixed-size sliding window, the full findings archive
  accumulates engine-side and is replayed once at synthesis rather than per
  hop, and rejection history compacts to a bounded ring of one-line entries.
  The retry history is the phase's append-only provider-native transcript:
  every attempt appends the model's own `AIMessage` followed by one
  `ToolMessage` per call in call order — the accepted result or the rejection.
  Nothing is rebuilt or rewritten; when the transcript outgrows its budget,
  whole leading attempt groups are dropped, oldest first, never a partial
  message. The exchange ends on the rejection's tool result; no host-authored
  user turn follows it. Hop context
  is node-proportional and non-cumulative: a large focus-node DDL raises one
  hop's message and is gone the next.
- Synthesis starts from a fresh completion envelope containing the archived
  findings plus engine-owned lifecycle and column-provenance state.

`NavigationEngine`, not prompt prose, owns agenda, gates, routing validation,
pruning, closure, and termination. Persisted node actions are `analyze`,
`passthrough`, and `prune`.

## Template customization contract

`templateRenderer.ts` routes template keys mechanically by stage, answer
classification, column-aspect presence, focus type, and result size. An overlay may
replace instruction text but cannot change those gates.

The shipped template file groups the public customization surface into:

- discovery answer style (`discovery_chat`);
- active capture instructions for business, technical, the shared structural
  callouts, structural/non-bodied, and column-trace evidence;
- synthesis instructions for summary, title, introduction, closing,
  highlights, notes, and technical loading patterns;
- a shared `general` style layer.

Business and technical capture follow the locked classification. Each hop
receives BB guidance,
with CT capture added only when the column aspect is present. A CT
exploration can therefore contain BB-only hops. Structural capture replaces
business and
technical capture on non-bodied focus nodes and renders on its own, with no
header. On a bodied focus the capture recipe opens with an engine-owned header
that an overlay cannot replace: a `sections` object keyed by angle, SQL quoted
only as an exact substring of the focus DDL, and the `not established from the
available SQL` wording. The business, technical and structural-callout keys
carry only their numbered items and the ⚠️ rule, never a copy of that header.
The closing instruction may be
omitted for small results. Empty template values are skipped. Templates are
self-contained: no template references another template or a slot that its
own rendering combination can suppress (the ETL loading-pattern statement
carries its own fallback destination when no closing is requested).

The exact key set and default prose are intentionally documented in
[`assets/aiOutputTemplates.yaml`](../assets/aiOutputTemplates.yaml), so this
guide does not duplicate an inventory that can drift.

### Upgrading a custom overlay

The template file carries a `schemaVersion`, and a custom overlay set through
`dataLineageViz.ai.outputTemplateFile` is applied only when its `schemaVersion`
equals the version the installed release expects
(`AI_TEMPLATE_SCHEMA_VERSION` in
[`src/ai/session/types.ts`](../src/ai/session/types.ts)).

A release bumps that version only when the shipped file changes in a way an
older overlay can no longer fit — a template key removed or renamed, or a
field removed or retyped: with those, an overlay that still clears the
version gate would be silently mis-applied. An added template key or field
never bumps — the overlay merges over the built-in file, which fills
everything the overlay lacks, so a previous overlay keeps working unchanged.
Wording inside `instruction` is content and never
bumps the version (nor does `example`, which the loader never reads at all): an older overlay with different prose
still parses and renders, so a wording change in a release leaves existing
overlays in force. The release gate
([`tests/tools/assert-template-schema-version.mjs`](../tests/tools/assert-template-schema-version.mjs))
compares the structural fingerprint of the file against the last release tag
(or `origin/main` when the repository has no release tag) and fails when a
breaking change ships without a bump — or the version moves without one.

On a version mismatch the extension does not fail and does not silently
mis-apply the file. It writes a warning naming the file and the expected
version to the **Data Lineage Viz** output channel, then falls back to the
built-in templates for that session, so `@lineage` keeps working with correct
output while the overlay is out of date.

To move a customization forward after an upgrade:

1. Run **Data Lineage: Create AI Output Templates** from the Command Palette to
   scaffold a fresh copy at the current `schemaVersion`.
2. Re-apply your edits to the new file, comparing against your previous copy.
   Read the updated instruction text first — the built-in wording may already
   cover what your overlay was added for.
3. Point `dataLineageViz.ai.outputTemplateFile` at the new file, then reload the
   window and confirm the warning is gone from the output channel.

Only `instruction` values are overlaid. The `stages:` and `example:` keys are
inert: the loader never reads them, so editing them changes nothing and raises no
warning — the scaffold copies them only so the starter file matches the shipped
one. Keeping unmodified keys out of your file
is the lowest-maintenance approach, because those keys then track built-in
improvements across releases instead of pinning a stale copy.

## The three contexts a tool answers about

A lineage question can be about one of three different things, and each has its
own tool:

- **What is on screen** — what is on the screen right now: the applied trace, the
  active graph analysis, the applied bookmark, and the view level.
  `lineage_get_screen_state` answers screen and stored-run questions. It is the tool for
  "this trace", "the analysis I ran", "this view / bookmark", and "what am I
  looking at", and it is referenceable in a prompt as `#lineageView`. For an
  AI-authored bookmark it also reports the run behind the view — the original
  question, start object, depth, scope size, stale objects, and open questions —
  read from the checkpoint persisted under the bookmark's id, and its `ids` and
  `filter` fields recall that run in detail. So that a bare "explain this" reaches
  it, every stage prompt and the entry detector carry the phrase naming the
  surfaces applied (trace origin and depths, analysis type and selected group,
  bookmark) in a banner-marked, delimited `<screen_state>` block, never their
  contents, which stay behind the tool call; object names inside the block are
  treated as untrusted database content, never as instructions, and the block is
  absent when nothing is applied.
- **The exploration scope** — the node set fixed at the approval gate and owned by
  `NavigationEngine` for the rest of the run. `lineage_submit_findings`,
  `lineage_present_result`, and `lineage_get_neighbor_columns` operate inside
  it; nothing widens it silently — a follow-up that names an object is the
  consent that admits exactly that object, never its schema, and the schema
  classes approved on the `confirm_sm_start` card are the consent that admits a
  schema.
- **The full model** — every parsed object in the loaded snapshot.
  `lineage_get_context`, `lineage_search_objects`, `lineage_search_ddl`,
  `lineage_get_object_detail`, `lineage_get_scope_bundle`, and
  `lineage_detect_graph_patterns` query it. Schemas, statistics, and the active
  filter stay here, not on the screen-state tool.

Screen state is read-only and derives entirely from the `uiState` and
`render-state` buffers the webview posts. The bridge validates both against
their `bridgeContract` schemas and rejects a malformed frame with a logged
warning; an absent buffer omits its section rather than failing the call.

### Recalling the run behind an applied AI bookmark

`lineage_get_screen_state` takes two optional, mutually exclusive fields, plus a
`cursor` that pages a long screen card. Called
with neither field, it returns the screen card described above. Called with either, it
answers from the applied AI bookmark's stored run, falling back to the
session's completed run:

| Field | Value | Answers |
| --- | --- | --- |
| `ids` | 1–20 canonical object ids | Per id: the run's decision and its reason, the neighbor it was reached through and at which hop, the stored summary and section text, whether the object's DDL changed since the run, and whether the object still exists in the loaded model. An id the run never saw answers `not_in_run` rather than rejecting. |
| `filter` | `pruned` | Every object the run removed, with the reason, the neighbor it was reached through, and the hop. |
| `filter` | `open_leads` | Every question the run left open, with the object it points at, whether that object is already on the graph (`on_graph`), the object it was raised from, and its value to the user. |
| `filter` | `stale` | Every in-scope object whose DDL no longer hashes to the value stored at save time. |

Staleness is a content hash comparison against the DDL recorded when the
bookmark was saved. An object whose DDL was unavailable at save time is stored
as unknown and never counts as stale. Recalled findings describe an object as it
was at run time, so the prompt contract is to confirm a stale object with
`lineage_get_object_detail` before answering from the recall.

The response carries a `_token_estimate` and is never truncated: a recall over
the discovery token budget is hard-rejected with the standard
`over_discovery_budget` envelope and a hint naming how far to narrow `ids`. Only
`lineage_get_scope_bundle` reroutes on that shared envelope; this recall path
stays inline, so the model narrows and re-reads rather than leaving discovery.
When neither an applied bookmark run nor a completed session run is available,
the call answers `no_run_memory` with a recovery hint.

## Exploration tool contracts

### Start exploration

The origin comes from `lineage_search_objects`, whose `name_match` resolves a
typed name deterministically: exact-name rows, narrowed to the user's filtered
schemas when any sit in them, served as `unique` or `ambiguous` ids. The model
asks in text only on `ambiguous`.

A fresh `lineage_start_exploration` proposal requires an origin, an explicit
analysis mode, and an answer classification. BB traces whole objects and does
not accept named target columns. CT requires user-named `targetColumns`.
`discovery` is the entry detector's default whenever the route is unclear;
naming a column already discussed earlier in the conversation is not, by
itself, enough to route into a column trace — that route requires an explicit
new request to trace or walk a named column. Under-choosing a column trace
costs nothing: the approval gate still lets the user switch `analysisMode`
before anything runs.
Pending-gate refinements are strict patch requests tied to the gate revision.
Omitted origin, question, depth (direction is derived from it), filters, mode,
classification, and columns keep their reviewed values. The mission brief is
retained only when origin, mode, target columns, and depth are unchanged. The refine stage may
search objects to resolve a typo, pattern, ambiguity, or newly named object, but
does not re-resolve the unchanged origin or rerun discovery;
completed-session supplements carry explicit node IDs and reuse the existing
archive. A supplement ID needs no lead behind it and no second approval — the
user's request is the consent, and `supplement.chain` follows the named objects
upstream or downstream to a depth or to the end — but an ID the user excluded
is still refused,
and a rejection that has no corrective call tells the model to answer rather
than to resend.

Every fresh SM exploration passes through the consent gate. A bounded visual
preview is a separate discovery path and does not grant SM mutation authority.

### Submit findings

`lineage_submit_findings` uses a mode-specific strict schema. Every hop states a
per-hop verdict: `analyze` (transforms data on the answer path), `passthrough`
(on the path, handing values on unchanged), or `end_branch` (removes this node,
and every open node reachable only through it, from the result for the rest of
the run). A kept verdict (`analyze` or `passthrough`) requires `sections` and
`summary`, and may add `badge_label`; `end_branch` requires `reason`, refuses
`prune_neighbors` and `questions`, and takes `summary` and `sections` omitted
or ignores them, and `badge_label`, when sent. `summary`, `sections` and
`reason` are served optional at the schema; the verdict-dependent requirement
(a kept verdict still needs `sections` and `summary`) is enforced at parse.
A kept verdict ignores any `reason` sent with it (logged, never rejected).
`end_branch` is refused on the start object (`prune_origin_forbidden`). In
column trace, object retention follows the shared
BB decisions; column evidence is not a separate reason to change that graph.

- BB accepts the focus verdict, classified sections, and two optional
  neighbor-decision arrays: `prune_neighbors` (`[{id, reason}]`, based on this
  node's SQL alone) and `questions` (`[{nodeId, question}]`, a specific check
  attached to that neighbor's queued hop). There is no separate routing field —
  every remaining open in-scope neighbor not named in `prune_neighbors` is
  enqueued and visited once, automatically, through the standard border
  checks. A neighbor prune is a sender vote; removal waits for live senders
  and requires all recorded votes to favor pruning. Once resolved, it cuts
  unvisited nodes reachable only through that neighbor; naming a neighbor already visited, analyzed,
  queued or removed is a no-op (`prune_noop_visited`, `prune_noop_analyzed`,
  `prune_noop_queued`, `prune_noop_removed`) and changes nothing.
- A hop with a column aspect accepts the same BB decisions plus model-authored
  `column_flow`. A hop without that aspect is pure BB, even in a CT session. Column records add provenance and never narrow the graph;
  there is no CT write-sink exception. The backend validates declared objects,
  columns, and links, but does not infer unique carriers or write mappings.
  Missing attribution is expressed as a source-qualified unresolved question
  naming the relevant object and column, not supplied by the backend.
- Column identity follows the resolved object kind and authoritative metadata
  ([architecture contract](ARCHITECTURE.md#verified-column-identity-by-object-kind)).
  Table/view outputs must be real declared columns, including established view
  aliases; metadata absence does not permit arbitrary names. External nodes
  are actual `external` objects (`et`, `file`, `db`, or legacy subtype), and
  any known columns still validate. Without available columns, their existing
  contextual-attribution path remains allowed; catalog external tables normally
  have declared columns, so actual metadata availability determines the check. Procedures carry source references and explicit write
  destinations, not owned stored columns. Scalar parameters are binding
  context for qualified caller outputs; table-valued function result columns
  are distinct from their inputs. Missing evidence stays unresolved, without
  inferred links or pruning.
- On a procedure CT hop, every served `column_flow` entry requires `writes_to`:
  the explicit destination object and column, or `null` when there is no table
  write. The stored record contract remains optional and tolerant of older
  records that omit it; omission does not infer a write. Downstream `out_col`
  names the resolved output, including a rename, rather than being restricted
  to the incoming column name.
- Each upstream column reference in `column_flow` may carry `transforms`: how
  that upstream column reaches the output column, as one or more of
  `pass_through`, `compute`, `aggregate`, `combine` and `filter`. Multi-select,
  because one edge is routinely several classes at once. The field is optional
  and is omitted rather than guessed when the DDL does not settle it — the engine
  verifies a classification but never authors one, so an unclassified edge stays
  unclassified. The value set and its DIRECT / INDIRECT split have one home,
  `COLUMN_TRANSFORM_CLASSES` in `src/engine/shared/bridgeContract.ts`, shared by
  the tool schema, the wire contract and the webview.
- Column context comes from recorded model-authored links. A retained neighbor
  without a column aspect receives the shared BB instructions. Neither a matching
  column name nor a single possible carrier establishes a write mapping.
  Object detail and active-hop context use shared object detail sections,
  including CTE evidence attached to the owning object's SQL; there is no
  CTE-specific storage subsystem.

Generated continuations and AI subquestions have different inputs. The
backend generates source-qualified continuations only from accepted authored
`column_flow` edges and attaches them to the relevant queued focus; it does not
populate them from every SQL reference or every metadata column. Generated
prose groups output names for each source; qualified destination identities
remain in actual edge records and caller context. The active
`current_task` includes those questions alongside all nonblank AI/ledger
questions and the current resolved columns. Actual rendering asks the model to
address the continuations but gives neither question set a PRIMARY label.
An AI neighbor subquestion must be self-contained and supplement the approved
question; an origin output mentioned in that prose is not proof of a neighbor's
column identity. Caller output targets and caller SQL are retained separately
for function binding. Neither question route guarantees an exhaustive column
inventory or repairs absent model-authored dependencies by inference.

An accepted `end_branch`, or a resolved neighbor prune, cuts every unvisited node
reachable from the origin only through it: the engine drops those nodes from
the open set, logs the cut, and records it as node state — the model is never
told which nodes a cut removed. The scheduler dispatches the remaining open
nodes by Kahn readiness (a strongly connected component, found by Tarjan,
dispatches as one unit) and tie-breaks a ready set by tier, then distance from
the origin, then id; a node is visited at most once.

The locked answer classification determines which section angles are required.
Validation requires the locked angles to be present on a fresh kept verdict.
The served JSON Schema uses separate `anyOf` alternatives for kept findings and
`end_branch`: kept findings require `summary`, `sections`, and every locked angle
(both `business` and `technical` under a `both` lock). A cut can omit them or send
empty sections. A retry with a held draft keeps the angle keys
optional. Under a single-angle lock the off-angle key is rejected at the
schema with a hint to fold its content into the kept angle, so a business-only
answer cannot carry technical sections. Neighbor,
column, and prune checks run before commit. A rejected submission does
not partially update findings, lifecycle, or scheduling state. Rejections return a
machine-readable error, corrective hint, and relevant valid-set details.
Unresolvable external references are recorded as notices and skipped when the
engine can safely continue. A repeated request for an object already removed
is reported as an already-pruned no-op rather than as an analyzed or retained
object.

### Present result

`lineage_present_result` receives structured presentation fields for both bounded
one-pass previews and completed hop-by-hop explorations. Synthesis authors text;
preview only groups the cached discovery answer into sections by block reference
and adds labels, node links, captions, and highlight groups. The engine owns validation, section
numbering, badge derivation, object links, markdown assembly, and graph closure.

Both stages are validated by the same rules, so both receive the same
presentation contract. The linking, captioning, and highlight-selection rules are
authored once and composed into every stage that calls the tool through the
shared phase dispatcher; only genuinely stage-specific material — the archive
evidence surfaces for synthesis, the answer-block reference contract for preview, the
depth and heading rules that license only the text-authoring stages — lives with
its stage. A stage that reaches the tool without that contract is a stage judged
by rules it was never given. The contract also states the enforced mechanical
checks upfront — unique section labels, trimmed nonempty highlight legend labels
with a 60-character readability limit (soft target: about 40 characters), at
least one highlight group without an upper count limit, and the held-draft repair
convention — so a model learns
each rule before its first call rather than from a rejection. The CT terminal-source mandate
(terminal sources must appear in a section's node ids or a source highlight
group) is stated in the synthesis prompt; no validator rejects its absence —
the engine-owned Column Trace Chain block carries the terminal-source facts the
prompt reasons from.

Validation is structural and field-scoped, and completes before commit.
Markdown and math formatting do not reject a call: unparseable math renders
as source text. A held `submit_findings` retry resends the full call, retaining
unchanged section angles. A held `present_result` repair resends authorized
corrected fields: sections merge by label, unnamed sections stay, and
`{label, remove: true}` removes one. Structural repairs replace notes and
highlights as whole lists. A rejection confined to highlight labels permits
indexed `highlight_groups` label replacements; one confined to section labels
or text permits indexed `sections` replacements for only the named fields.
The held report keeps every other field and array position, and the assembled
report is validated before commit. Each rejection states which fields may be
repaired.

One submission produces one complete rejection. Checks that need context the
validator does not hold — the cached discovery answer, the result graph — report
their findings into the same accumulator instead of rejecting on their own, so a
payload that breaks two rules is told about both in one round. Rejections name
the offending entry paths, not only the rule, so a repair does not have to
locate the defect by elimination. Both matter to the attempt budget: each defect
class disclosed on its own round is one more reply without progress.

For a new render, sections and highlights are required. A node can belong to at
most one final section; highlighted nodes must be explained by a section or
note. Nodes may remain visible without a badge or highlight. In CT mode,
the synthesis prompt requires terminal source nodes reached by the validated
column chain in the final source presentation; this is not a validator rejection.

There is no AI-writeable assembled `description` field. The engine builds the
rendered document from title and numbered section bodies. For preview, the host
supplies the cached discovery answer and retained bounded scope directly; no
lookup tool is exposed. The answer is split into top-level markdown blocks
(`marked.lexer`) and served as `answer_blocks`, numbered B1..Bn. A preview
section carries `label`, `node_ids` and `start`, the served block id it begins
at (a `z.enum` of B1..Bn built per request), and no text: the engine ends each
section before the next section's start (the first begins at B1, the last runs to
the end) and assembles its body from those blocks, so the model never retypes the
answer. A start that does not follow the one before it is reported at
`sections.N.start`. A thematic break or blank run in the answer gets no block id
and folds into its neighbouring block. `notes` take the same
`{node_id, caption}` shape as synthesis; a caption is the model's own one-line
label, never compared with the answer text. A rejected preview is repaired by label: the retry resends only the
named section, and every held section not resent is kept; `{label, remove: true}`
drops one. The repair hint does
not ask for `is_update`. Synthesis continues to author its report from the
completed exploration archive.

## Phase policy and completed follow-ups

[`src/ai/tools/toolPolicy.ts`](../src/ai/tools/toolPolicy.ts) is the canonical
phase/tool map. Discovery answers from snapshot tools and does not publish a
`NavigationEngine`; `lineage_get_scope_bundle` still stores discovery evidence
and is therefore participant-internal, not a `vscode.lm` tool. Visual preview,
SM entry, active submission, synthesis, and completed follow-ups each receive
only their phase-valid tools; completed follow-ups keep every discovery read
tool so they can walk the graph beyond the report. Production dispatch is direct through the local
registry and does not call `vscode.lm.invokeTool`.

After a preview is accepted by the active graph webview, chat emits only a short
confirmation and does not add a redundant **Show in Graph** action. If automatic
dispatch did not succeed, the existing action remains available.

Native `ChatContext.history` is adapted into ordered user/assistant text. Tool
call/result pairs are preserved only when matching native metadata is present;
orphan tool messages are not fabricated. Completed turns rely on the retained
conversation plus session-owned result/navigation state.

The **Show full description** follow-up replays the same cached presentation
artifact committed by `present_result`, without a model call. Other completed follow-ups can adjust presentation,
supplement the existing exploration, start a fresh exploration, or answer
directly according to the phase policy.

## Graph and Markdown output

- Section labels drive numbered graph badges for their linked nodes.
- Nodes without section links may remain bare; notes provide optional
  node-specific captions.
- The final graph contains every retained scope node, including contracted
  topology-only passthroughs. Styling and separate hop analysis do not control
  graph membership; only validated pruning removes an object.
- Contracted in-scope objects are described as retained supporting objects.
  Schema and depth limits remain explicit deferred follow-up leads.
- The overlay keeps focus links interactive, while chat replay removes focus
  anchors for readability.
- [`src/components/markdown/renderAiMarkdown.ts`](../src/components/markdown/renderAiMarkdown.ts)
  renders the assembled document with `marked`, the KaTeX extension vendored from
  VS Code in
  [`markedKatexExtension.ts`](../src/components/markdown/markedKatexExtension.ts),
  and DOMPurify. Math therefore follows the same delimiter rules VS Code applies
  to chat responses: `$…$` inline and `$$…$$` for a block, with prose amounts such
  as `$20,000` excluded by the surrounding-character guards rather than by
  disabling the delimiter. An expression KaTeX cannot parse renders as its
  original source text — preserving source takes priority over cosmetic rewriting,
  and no formatting flaw can reject a call or end a turn.
- Heading ownership: the engine owns the document title, numbered section
  headings, and object link headers (H1-H3). AI-authored section bodies must
  not emit `#`, `##`, or `###` headings; use bold labels inside a body. The
  shared presentation contract states this rule to the text-authoring stages
  (synthesis and completed follow-ups); preview is exempt because its bodies
  are blocks of the cached answer.

## SQL witness contract

Capture-template grounding blocks require SQL witnesses to be exact
substrings of the hop's DDL (never paraphrased). Gaps are stated as
`not established from the available SQL` instead of inferred. Synthesis
preserves exact node IDs, parameter names, and formulas through compression.

Static SQL may identify a candidate performance pattern only. Sargability,
index benefit, join strategy, parameter sniffing, and statistics staleness
need catalog or runtime evidence.

## Editing and verification

1. Run **Data Lineage: Create AI Output Templates** to scaffold an overlay.
2. Set `dataLineageViz.ai.outputTemplateFile` to the overlay path.
3. Reload the VS Code window.
4. Exercise each changed stage/classification/mode combination in the Extension
   Development Host.
5. Inspect **Output → Data Lineage Viz** at Debug level for selected templates,
   hop diagnostics, and structured rejection envelopes.
6. Verify the final chat answer, graph badges/highlights, and notes together.

`npm run test:runtime` checks agent-runtime and state-machine contracts,
including depth/gate and column-trace regressions. Template changes also need
manual review of the answer and graph; deterministic tests do not establish
AI answer quality.
