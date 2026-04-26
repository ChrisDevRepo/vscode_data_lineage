# AI Output Templates — YAML Tuning Guide

`@lineage` reads its capture and rendering rules from a single YAML file: [`assets/aiOutputTemplates.yaml`](../assets/aiOutputTemplates.yaml). This document is your map for editing that file — what each key does, when it fires, and what to maintain alongside what.

The YAML is the only authoritative surface. Everything below describes how the YAML drives behaviour. For the broader engine architecture (Map & Router, hop payload, state machine) see [`ARCHITECTURE.md`](ARCHITECTURE.md).

## How to override

1. Command Palette → **Data Lineage: Create AI Output Templates** — copies the built-in YAML into your workspace.
2. Set `dataLineageViz.ai.outputTemplateFile` to its path.
3. Edit the `instruction:` field on any key. Your overlay merges on top of the built-in defaults; your keys win, missing keys fall back to the defaults.
4. Unknown keys are logged at WARN and ignored. A bad overlay never breaks activation — at worst the affected key reverts to its default.

Only the `instruction:` text is injected into the prompt. The `example:`, `good_example:`, and `bad_example:` fields exist for the human reader; the AI never sees them.

## Section vs subsection — the mental model

Two layers, written by two phases:

| Layer | When it's written | What it is | Driven by |
|-------|-------------------|------------|-----------|
| **Per-hop capture (one archive slot per visited bodied node)** | Each hop during exploration | Full analysis of *one* view / procedure / function. Every formula, every column, every ⚠️. Stored unbounded in the Detail Archive. Never shipped mid-loop. | `business_capture`, `technical_capture`, `structural_summary` |
| **Final document section** | Synthesis turn (after agenda drains) | One `## <label>` block in the report. Synthesis groups archive slots by label — same label = one section, with multiple node IDs cited. | `sections`, `intro`, `closing`, `summary`, `title`, `description`, `highlights`, `notes` |

Inside one section, the body is split into one or two **subsections** depending on mission type:

- A `business`-only section emits the `business_subsection` body.
- A `technical`-only section emits the `technical_subsection` body.
- A `both` section emits the business body first, followed by `#### Technical` (the `technical_subsection` body).

So the rendering pipeline reads:

```
hop 1, hop 2, …, hop N         →  N archive slots  (capture keys)
                                          ↓
                       group by label, lift per-slot text
                                          ↓
                  K final sections (sections key)
                                          ↓
        for each section: business / technical / both subsections
```

Synthesis assembles, groups, frames — it does not rewrite. If the archive does not contain a fact, the final document cannot mention it. Capture must be exhaustive.

## Mission type drives what fires

The AI declares the mission type at `start_exploration` via the optional `classification` parameter (`business` | `technical` | `both`). If omitted, the engine defaults to `business`. The chosen value is shown in the `confirm_sm_start` gate as `**Analysis:** <label>` so you can see what will be captured before approving.

Once set, the mission type drives which capture and subsection keys fire:

| Mission type | Active phase fires | Synthesis fires | Sections per node (active) | Sections per label (synthesis) |
|--------------|--------------------|-----------------|---------------------------:|-------------------------------:|
| `business` | `business_capture` + `structural_summary` (only on table origin) | `business_subsection` + non-gated synthesis keys | **1** (business) | **1** (business) |
| `technical` | `technical_capture` + `structural_summary` (only on table origin) | `technical_subsection` + non-gated synthesis keys | **1** (technical) | **1** (technical) |
| `both` | both `*_capture` + `structural_summary` | both `*_subsection` + non-gated synthesis keys — **longest prompt** | **2** peer (business + technical) | **2** peer (business + technical) |

The contract is locked mechanically: each `submit_findings` call must carry exactly the `sections[]` shape implied by the mission. Mismatches reject with `classification_lock_violation` (e.g., a `business`-mission slot carrying a `technical` angle, or a `both` slot missing one angle). At synthesis, `present_result.sections[]` carries one peer entry per captured angle per node — the two angles never nest as `#### Technical` subheadings; they are independent peer sections.

`sections`, `intro`, `closing`, `summary`, `title`, `description`, `highlights`, `notes` are not gated by mission type — they always fire for their stage.

### Column-trace overlay (CT)

CT mode is a **purely additive** overlay on top of mission type, activated when `start_exploration` is called with `targetColumns`. It does not change which YAML keys fire and it does not replace the business / technical section contract — when CT is approved, the AI still fills out one section per fired `*_capture` template (1 for `business`/`technical`, 2 peer for `both`) per node. CT only adds an extra technical instruction about *how* the columns are tracked and stored in the sliding-memory archive. It adds:

- A `<column_state>` block to the per-hop system prompt listing `target_columns`, `done_columns`, `active_columns`.
- Column-level validation on `route_requests` — the AI cannot route to a non-existent column.
- A `column_flow` requirement in `submit_findings` for column attribution.

A `both` + CT session has the longest active-phase prompt: both capture instructions + the column-state overlay + the standard hop payload.

## Key inventory — purpose & maintenance

### Synthesis — the final document on the chat panel + graph card

| Key | Purpose | Edit this when |
|-----|---------|----------------|
| `summary` | One-line graph-card teaser (~120 chars). Shown on the AI view card and at discovery for trivial single-object questions. | Tightening or loosening the card-line tone; changing the max-character target. |
| `title` | The `# …` document heading (≤ 80 chars) naming the analysis subject and key finding. | Changing how the title balances subject vs. finding; banning step counts. |
| `intro` | 2–4 sentence narrative opener before the sections. | Changing tone, what the intro is allowed to mention (e.g. ban schema dumps), or how it anchors to the user's question. |
| `sections` | Section assembly contract — density floor, sibling-variant grouping, label-by-role rule, no leading numbers in headers. | Changing how many sections you want, when sibling procedures collapse into one comparison table vs. each get their own H2, or how sections are labelled. |
| `closing` | Optional `---` divider + cross-cutting through-line / risk. | Changing when a closing fires (e.g. always vs. only on 5+ sections) or what cross-cutting issues warrant it. |
| `description` | Fallback long-form body, used only when `sections[]` is absent. | Changing the unstructured fallback's shape and depth target. |
| `highlights` | 2–3 critical-node glows on the graph (Lineage or Diagnostic scheme). | Changing how aggressively to highlight or the colour scheme. |
| `notes` | Per-node graph captions — one-line, what the node does specifically in this flow. | Changing caption length or style (e.g. always lead with the formula vs. the role). |
| `business_subsection` | Section body for the business angle: formulas, `\| From \| To \| Business meaning \|` table, ⚠️ inline rule. Mirrors `business_capture`. | Changing how business rules render at full depth in the final document. Edit alongside `business_capture` so capture and render agree. |
| `technical_subsection` | `#### Technical` subheading body: SQL snippets + LaTeX formulas side-by-side, join strategy, antipatterns. Mirrors `technical_capture`. | Changing how technical content renders. Edit alongside `technical_capture`. |

### Active — per-hop capture into the unbounded archive

| Key | Purpose | Edit this when |
|-----|---------|----------------|
| `business_capture` | The body of the section the AI submits with `angle: 'business'` per hop (one entry in `submit_findings.sections[]`): business meaning, formulas, column renames, ⚠️ invariants, question-relevance evidence. Fires when classification ∈ {business, both}. | Adding a per-hop business-content requirement (e.g. "always list affected consumers"). Each capture template is independent — no cross-references to other capture templates. |
| `technical_capture` | What the AI writes for the technical angle: verbatim SQL, loading pattern, joins, antipatterns, distribution hints. | Adding a per-hop technical-content requirement (e.g. "always note hash-distribution column"). |
| `structural_summary` | Reduced active-phase template fired only when the user's starting point is a non-bodied node (a table). Replaces `business_capture` / `technical_capture` for that one hop with a Purpose / Columns / Upstream / Downstream / Grain skeleton. | Changing the table-origin slot shape — e.g. adding an FK / index sub-section. Don't put transform formulas here; those belong in the procedure slots. |

## Maintenance rules

- **Mirror capture and render edits.** When `business_capture` says "list every CASE branch", `business_subsection` should say "render every branch from the archive". If the two drift, captured content fails to surface or output references content that was never captured.
- **Edit the `instruction:` field, not the examples.** Only `instruction` is injected into the prompt. The example fields exist for the human reader.
- **Avoid character ceilings on archive fields.** The archive is unbounded; capping section text per slot pushes the model to pre-compress, which starves synthesis for detail. Describe quality criteria ("cover every business rule and SQL evidence point"), not character counts. Per the design rule: AI does grouping/order, system does numbers.
- **Verdict names are locked.** `analyze` / `pass` / `prune` are enforced by a Zod enum on `submit_findings.verdict`. Only the YAML descriptions can change, not the names.
- **Don't hand-edit the stage routing.** `STAGE_BY_KEY` in [`src/ai/templateRenderer.ts`](../src/ai/templateRenderer.ts) is the authoritative routing. Adding a new key requires both a YAML entry and a `STAGE_BY_KEY` registration.

## How to verify a YAML edit

1. Reload the VS Code window (Command Palette → **Developer: Reload Window**) so the overlay is reread.
2. Run an exploration that exercises the key you changed.
3. Open `View → Output → Data Lineage Viz` and set the channel log level to **Debug** (gear icon → Set Log Level → Debug).
4. Look for `[AI] [Hop N]` lines emitted for each successful `submit_findings` — they show character counts written into the archive (`detail=…`, `summary=…`). A drop on a hop you just tightened means the AI captured less; a jump means you broadened.
5. The synthesised document is in the chat panel; the structured view is in the AI view card. Compare against an earlier run if you want a delta.
