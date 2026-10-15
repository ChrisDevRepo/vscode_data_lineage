# AI prompts and output templates

The first part is for users who change how `@lineage` writes answers; the second is for anyone changing the prompts in a clone. Hops, BB and CT are explained in [Architecture](ARCHITECTURE.md#exploration).

## Customize output templates

Tools validate arguments without rewriting them. Copy object IDs exactly from tool results, send arrays and objects as JSON values rather than strings, and use numeric values for numeric depth fields. Rejections identify the field to repair; accepted prose is retained verbatim.

Output templates control the tone, structure and detail of `@lineage` answers, not which objects it visits or how results are validated.

1. Run **Data Lineage: Create AI Output Templates** from the Command Palette. It copies the built-in templates to `aiOutputTemplates.yaml` in the first workspace folder.
2. Set `dataLineageViz.ai.outputTemplateFile` to that file. A relative path resolves against the first workspace folder.
3. Edit the `instruction` text of the keys you want to change. Your file is merged over the built-in templates, so you can delete the rest.

### Template keys

| Key | When it is used | What it shapes |
|---|---|---|
| `discovery_chat` | Chat answers before or without an exploration | Tone, structure and detail of the answer |
| `business_capture` | Each hop of a business or combined exploration | What is recorded about an object's business meaning |
| `technical_capture` | Each hop of a technical or combined exploration | What is recorded about an object's execution |
| `structural_callouts` | Each hop on an object with a SQL body | Warnings backed by the object's SQL |
| `structural_summary` | Retained for template compatibility; automatic storage visits do not call the model | Does not affect the current exploration's storage records |
| `column_trace_capture` | Each column-trace hop that carries column work | How column provenance is explained |
| `summary`, `title`, `intro`, `closing` | Final report | Info card line, title, opening and closing (`closing` is skipped below three detailed nodes) |
| `highlights`, `notes` | Final report | Highlight groups and per-node notes on the graph |
| `loading_pattern` | Final report of a technical or combined exploration | How load patterns are summarized |
| `general` | Final report | Section structure and rules for lists, tables, SQL fences and callouts |

### What the extension reads

- `instruction` replaces the built-in text; an empty one is ignored.
- `sections` (on `business_capture` and `technical_capture` only) is an optional ordered list of bold section labels; `{{sections}}` in `general` expands to them.
- `stages` and `example` are not read. Unknown keys are skipped with a warning; a key set to a plain string invalidates the whole file.

Capture templates run under a fixed header you cannot override. Write each instruction to stand alone; do not refer to "above" or "below". Instructions replace presentation guidance, but cannot bypass consent, scope, identity checks or output schemas. Synthesis may rephrase hop findings, so wording needed in the final report belongs in a final-report key.

### Reload and check your changes

Templates load on activation and whenever `dataLineageViz.ai.outputTemplateFile` changes, so re-save the setting or reload the window after editing. **Output → Data Lineage Viz** logs `Applied AI templates:` with the keys taken from your file, and reports unknown keys, invalid `sections` and load failures. Then ask a question in chat and check the answer against the source SQL.

### Keep `schemaVersion` current

Your file must declare the same `schemaVersion` as [`assets/aiOutputTemplates.yaml`](../assets/aiOutputTemplates.yaml); otherwise the extension warns and uses the built-in templates. A breaking removal, rename or field-type change requires a new version; wording and additive changes do not. To upgrade, move your old file aside, run **Data Lineage: Create AI Output Templates** again, copy your `instruction` edits across and point the setting at the new file.

## How prompts are built

`@lineage` runs in stages (discovery, gate, one hop per object, synthesis), each with its own prompt and tools. Stage prompts state the task, tool schemas own field contracts, and templates own presentation; a rule belongs in exactly one. See [Exploration](ARCHITECTURE.md#exploration).

One tool catalog serves every caller; seven read-only tools are also exposed to Copilot agent mode through the generated `languageModelTools` manifest in `package.json`.

### Hop memory

Discovery and follow-ups use ordinary conversation history. Each hop sends a stable system prefix (protocol, mission brief, original question, discovery summary) and a short per-hop message (focus object, arriving tasks, capture template, recent summaries and rejections). After each committed hop the thread restarts from one continuation message; findings are replayed once at synthesis.

A hop gets CT instructions only when it carries column work; otherwise it runs as BB. Carried tasks keep qualified object and column endpoints and the traversal side, not bare column names. A function investigation keeps the caller SQL, the requested output and the function definition on every retry. Parameters are caller-binding context, not invented graph columns. An object dependency alone does not establish a column contribution, and valid identifiers do not prove a complete or correct SQL interpretation.

The hop message distinguishes assigned endpoints from unresolved candidates using existing qualified task identities. A directly assigned endpoint asks for continuation or finality; assignment alone does not claim a preceding mapping. A table forwards its question and qualified candidates automatically: downstream SQL establishes whether it uses a value, upstream SQL whether it writes a stored output. The same engine path handles added tables, merges purposes and endpoints before dispatch, and respects the approved border.

Each SQL hop submits findings, confirmed mappings and neighbor questions or prunes, without an analyze/passthrough choice. Unmapped candidates end on that branch. Assigned endpoints retain explicit continuation/finality accounting through `column_flow` and `terminated_inputs`; later object-only work stays BB. `storage_context` supplies the related table metadata and stored DDL without treating table definitions as loading SQL.

Only a SQL hop whose arriving work came through storage forwarding can receive `lineage_prune_current`. It takes `focus_node_id` and `reason`; one reply evaluates one hop-completion command. Existing committed mappings and independent direct tasks remain protected. Explicit pruning removes an irrelevant branch, while ending a column continuation with kept findings retains the node.

BB and CT share the same validation and correction path, defined in the [backend contract](../.agents/rules/backend-contract.md). CT can explicitly end an arriving input through `terminated_inputs` when other inputs continue; terminated branches cannot restart from later object-only work. Generated CT instructions describe accepted mappings alongside the AI's neighbor question.

Static SQL can suggest a performance pattern, but cannot establish actual index benefit, join strategy, parameter sniffing or statistics freshness without catalog or runtime evidence. Custom templates cannot give the assistant evidence absent from the loaded model.

## Change a prompt or tool description

Follow the [prompt-change workflow](../.agents/skills/prompt-change/SKILL.md). In short:

- Make the smallest change where the behavior is owned: stage prompt, tool schema or template.
- After changing a tool description or schema, run `npm run generate:tool-manifest` so `package.json` matches the catalog.
- For a breaking removal, rename or field-type change, update `schemaVersion` in the YAML and in `src/ai/session/types.ts` together.
- Run `npm run test:runtime` and `npm run gate`.
- For a change in model behavior, compare baseline and candidate answers with the [prompt-playground workflow](../.agents/skills/prompt-playground/SKILL.md).

### Where to change it

Templates: `assets/aiOutputTemplates.yaml`. Stage prompts: `src/ai/prompting/`, assembled in `src/ai/agent/`. Tools, schemas and phase policy: `src/ai/tools/`.
