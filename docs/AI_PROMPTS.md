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
- `package.json` owns the contributed tool descriptions and chat commands.

YAML is a customization layer, not the whole prompt. Phase instructions and
mechanical enforcement remain code-owned.

## Assembly and memory contract

The participant does not build prompts or own a tool loop. The outer graph
selects the stage, the stage builders assemble the instruction, and the model
bridge sends it to the exact `ChatRequest.model` selected by VS Code.

- Discovery and completed follow-ups can use the retained provider-neutral
  conversation. The completed follow-up prompt states what that context
  actually holds: the archive and rendered result graph are not replayed,
  detail is re-derived through the phase-valid read tools, and a presentation
  update replaces the section list wholesale — an omitted section is a deleted
  section.
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
  summaries, and rejection guidance in a bounded per-hop message. Broad
  participant history and prior-hop tool payloads are not replayed into every
  hop. The canonical question is resolved at `start_exploration` from
  user-authored text (verbatim discovery prompt, then the current turn's
  prompt) before the model-supplied paraphrase.
- Per-hop memory is tiered so repeated hops stay flat in size: recent hop
  summaries ride in a fixed-size sliding window, the full findings archive
  accumulates engine-side and is replayed once at synthesis rather than per
  hop, and rejection history compacts to a bounded ring of one-line entries.
  A rejected tool call is echoed back into history by name and call id only —
  its payload is never resent — and only the newest rejection carries the full
  repair envelope. Hop context is node-proportional and non-cumulative: a
  large focus-node DDL raises one hop's message and is gone the next.
- Synthesis starts from a fresh completion envelope containing the archived
  findings plus engine-owned lifecycle and column-provenance state.

`NavigationEngine`, not prompt prose, owns agenda, gates, routing validation,
pruning, closure, and termination. Persisted node actions are `analyze`,
`passthrough`, and `prune`.

## Template customization contract

`templateRenderer.ts` routes template keys mechanically by stage, answer
classification, column-trace mode, focus type, and result size. An overlay may
replace instruction text but cannot change those gates.

The shipped template file groups the public customization surface into:

- discovery answer style (`discovery_chat`);
- active capture instructions for business, technical, structural/non-bodied,
  and column-trace evidence;
- synthesis instructions for summary, title, introduction, closing,
  highlights, notes, and technical loading patterns;
- a shared `general` style layer.

Business and technical capture follow the locked classification. Column-trace
capture is available only in CT mode. Structural capture replaces business and
technical capture on non-bodied focus nodes. The closing instruction may be
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

A release bumps that version whenever a change to the shipped instructions
would make an older overlay wrong — a key renamed or removed, the `instruction`
shape changed, or instruction content that changes a rule the result validator
enforces, such as heading ownership, section counts, or grounding. Content
changes count: an overlay whose text predates the current validator produces
malformed output while looking perfectly valid.

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

Only `instruction` values are overlaid. Keeping unmodified keys out of your file
is the lowest-maintenance approach, because those keys then track built-in
improvements across releases instead of pinning a stale copy.

## Exploration tool contracts

### Start exploration

A fresh `lineage_start_exploration` proposal requires an origin, an explicit
analysis mode, and an answer classification. BB traces whole objects and does
not accept named target columns. CT requires user-named `targetColumns`.
Pending-gate refinements are strict patch requests tied to the gate revision.
Omitted origin, question, mission brief, direction, depth, filters, mode,
classification, and columns are inherited mechanically. The refine stage may
search objects to resolve a typo, pattern, ambiguity, or newly named object, but
does not re-resolve the unchanged origin or rerun discovery;
completed-session supplements carry explicit node IDs and reuse the existing
archive.

Every fresh SM exploration passes through the consent gate. A bounded visual
preview is a separate discovery path and does not grant SM mutation authority.

### Submit findings

`lineage_submit_findings` uses a mode-specific strict schema:

- BB accepts the focus verdict, classified sections, routing requests, and
  optional neighbor pruning. Neighbor pruning applies only to topology-safe
  adjacent objects outside the approved exploration scope; approved in-scope
  objects remain protected and can be removed only through their own validated
  focus verdict.
- CT accepts the same focus verdicts, requires `column_flow`, and rejects the
  BB-only neighbor-pruning field. Each active tracked column must be continued
  or marked terminal; an empty flow is valid only when the focus carries no
  active tracked-column interaction.

The locked answer classification determines which section angles are required.
Validation requires the locked angles to be present; off-classification
sections are then dropped deterministically at commit (not rejected — a
surplus section is not a field-scoped defect the held-draft repair flow could
patch), so a business-only answer cannot carry technical sections. Route,
column, and prune checks run before commit. A rejected submission does
not partially update findings, lifecycle, or routing state. Rejections return a
machine-readable error, corrective hint, and relevant valid-set details.
Unresolvable external references are recorded as notices and skipped when the
engine can safely continue. A repeated request for an object already removed
is reported as an already-pruned no-op rather than as an analyzed or retained
object.

### Present result

`lineage_present_result` receives structured presentation fields for both bounded
one-pass previews and completed hop-by-hop explorations. Synthesis authors text;
preview only regroups the cached discovery answer and adds labels, node links,
verbatim captions, and highlight groups. The engine owns validation, section
numbering, badge derivation, object links, markdown assembly, and graph closure.

Both stages are validated by the same rules, so both receive the same
presentation contract. The linking, captioning, and highlight-selection rules are
authored once and composed into every stage that calls the tool through the
shared phase dispatcher; only genuinely stage-specific material — the archive
evidence surfaces for synthesis, the verbatim-reuse constraint for preview, the
depth and heading rules that license only the text-authoring stages — lives with
its stage. A stage that reaches the tool without that contract is a stage judged
by rules it was never given. The contract also states the enforced mechanical
checks upfront — markdown/math delimiter integrity, unique section labels,
highlight legend labels, the 1-5 highlight-group cap, and the held-draft
repair convention — so a first rejection is no longer how a model discovers a
rule. The CT terminal-source mandate (terminal sources must appear in a
section's node ids or a source highlight group) is stated in the synthesis
prompt, matching the validator.

Validation is field-scoped and runs before commit. Malformed fenced or block
KaTeX, unclosed block-math fences, and unmatched inline-code delimiters reject
the affected text fields. A held-draft retry may repair only those rejected
text fields; graph membership, node associations, and highlights remain
unchanged.

One submission produces one complete rejection. Checks that need context the
validator does not hold — the cached discovery answer, the result graph — report
their findings into the same accumulator instead of rejecting on their own, so a
payload that breaks two rules is told about both in one round. Rejections name
the offending entry paths, not only the rule, so a repair does not have to
locate the defect by elimination. Both matter to the attempt budget: each defect
class disclosed on its own round costs its own semantic-failure charge.

For a new render, sections and highlights are required. A node can belong to at
most one final section; highlighted nodes must be explained by a section or
note. Nodes may remain visible without a badge or highlight. In CT mode,
terminal source nodes reached by the validated column chain must appear in the
final source presentation surface.

There is no AI-writeable assembled `description` field. The engine builds the
rendered document from title and numbered section bodies. For preview, the host
supplies the cached discovery answer and retained bounded scope directly; no
lookup tool is exposed. The submitted section bodies must partition that answer
verbatim and in order, and node captions must be exact excerpts. Any rewrite,
omission, or invented caption is rejected through the existing held-draft repair
flow, which exposes only the invalid fields on the retry. Synthesis continues to
author its report from the completed exploration archive.

## Phase policy and completed follow-ups

[`src/ai/tools/toolPolicy.ts`](../src/ai/tools/toolPolicy.ts) is the canonical
phase/tool map. Discovery tools are read-only; visual preview, SM entry, active
submission, synthesis, and completed follow-ups each receive only their
phase-valid tools. Production dispatch is direct through the local registry and
does not call `vscode.lm.invokeTool`.

After a preview is accepted by the active graph webview, chat emits only a short
confirmation and does not add a redundant **Show in Graph** action. If automatic
dispatch did not succeed, the existing action remains available.

Native `ChatContext.history` is adapted into ordered user/assistant text. Tool
call/result pairs are preserved only when matching native metadata is present;
orphan tool messages are not fabricated. Completed turns rely on the retained
conversation plus session-owned result/navigation state.

The **Show the full description** follow-up replays the same cached presentation
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
  Schema, depth, and budget limits remain explicit deferred follow-up leads.
- The overlay keeps focus links interactive, while chat replay removes focus
  anchors for readability.
- [`src/components/aiDescriptionMarkdown.ts`](../src/components/aiDescriptionMarkdown.ts)
  is a non-destructive preprocessing boundary.
- The overlay renders inline, block, and fenced math through `remark-math` and
  `rehype-katex`. Preserving source text takes priority over cosmetic rewriting.
- Heading ownership: the engine owns the document title, numbered section
  headings, and object link headers (H1-H3). AI-authored section bodies must
  not emit `#`, `##`, or `###` headings; use bold labels inside a body. The
  shared presentation contract states this rule to the text-authoring stages
  (synthesis and completed follow-ups); preview is exempt because its bodies
  are verbatim spans of the cached answer.

## Evidence-status contract (partially live)

Adopted from the 2026-08 AI SQL documentation review. Live today in the
capture-template grounding blocks: SQL witnesses must be exact substrings of
the hop's DDL (never paraphrased), and gaps are stated as
`not established from the available SQL` instead of inferred. The synthesis
detail contract additionally preserves exact node IDs, parameter names, and
formulas through compression. The full categorical vocabulary below remains
the agreed target; extend live templates only through an approved change plus
e2e replay.

Every captured claim carries one categorical evidence status:

- direct SQL evidence (`static`) — observable in the loaded snapshot;
- requires schema/index/statistics metadata (`metadata_required`);
- requires execution-plan or runtime evidence (`runtime_required`);
- requires business confirmation — intent, prevalence, or realized impact;
- not established — never filled by plausible inference.

Performance-claim tiering: static SQL may identify a candidate pattern only.
Sargability, index benefit, join-strategy quality, parameter sniffing, and
statistics staleness are `metadata_required` or `runtime_required`. On Synapse
Dedicated SQL Pool and Fabric Warehouse, actual data movement (shuffle/
broadcast) and its cost are established by distributed plans and runtime
evidence, never by query text alone. Engine targeting is required — SQL
Server/Azure SQL, Synapse, and Fabric must not receive identical movement or
tuning language.

## Editing and verification

1. Run **Data Lineage: Create AI Output Templates** to scaffold an overlay.
2. Set `dataLineageViz.ai.outputTemplateFile` to the overlay path.
3. Reload the VS Code window.
4. Exercise each changed stage/classification/mode combination in the Extension
   Development Host.
5. Inspect **Output → Data Lineage Viz** at Debug level for selected templates,
   hop diagnostics, and structured rejection envelopes.
6. Verify the final chat answer, graph badges/highlights, and notes together.

Run `npm test` for the full prompt/tool contract suite. Use
`npm run test:runtime` for the AI-core and navigation/state-machine projects, and run a
focused file with:

```bash
node tests/tools/run-vitest.mjs run tests/unit/sm/prompt-composition.test.ts
```

Prompt changes must update matching tests or fixtures. Generated trace snapshots
are diagnostic evidence, not a source of truth.
