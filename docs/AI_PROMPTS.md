# AI prompts and output templates

The first part is for users who change how `@lineage` writes answers; the second is for anyone changing the prompts in a clone. Hops, BB and CT are explained in [Architecture](ARCHITECTURE.md#exploration).

## Customize output templates

Tool and structured responses normalize supported representations before validation, logging conversions and retaining raw evidence. In JSON-text string values, unknown backslash escapes remain literal and raw C0 characters are escaped without changing their values; keys, standard escapes, incomplete syntax and exact numbers stay strict. Prefer canonical object IDs from tool results, send arrays and objects as JSON values rather than strings, and use numeric values for numeric depth fields. Equivalent SQL delimiters and whitespace outside identifier parts bind to the same unambiguous metadata identity; case follows the loaded source's CI/CS policy. Quoted spaces, all qualifiers and opaque identities stay significant. Unknown names and guessed aliases or schemas reject. Raw references remain in the evidence while routing and report links use canonical bindings. Rejections identify the field to repair; accepted prose is retained verbatim.

Column names use the shared SQL comparison helper: surrounding whitespace and identifier quotes are normalized for comparison, and case follows the loaded source's CI/CS policy. The submitted spelling stays intact; routing uses the matched metadata name.

Output templates control the tone, structure and detail of `@lineage` answers, not which objects it visits or how results are validated.

1. Run **Data Lineage: Create AI Output Templates** from the Command Palette. It copies the built-in templates to `aiOutputTemplates.yaml` in the first workspace folder.
2. Set `dataLineageViz.ai.outputTemplateFile` to that file. A relative path resolves against the first workspace folder.
3. Edit the `instruction` text of the keys you want to change. Your file is merged over the built-in templates, so you can delete the rest.

### Template keys

| Key | When it is used | What it shapes |
|---|---|---|
| `discovery_chat` | Chat answers before or without an exploration | Tone, structure and detail of the answer |
| `shared_capture` | Each hop on an object with a SQL body, once for all selected angles | Common purpose, transformations, grain and operations coverage |
| `business_capture` | Each hop of a business or combined exploration | What is recorded about an object's business meaning |
| `technical_capture` | Each hop of a technical or combined exploration | What is recorded about an object's execution |
| `structural_callouts` | Each hop on an object with a SQL body | Warnings backed by the object's SQL |
| `structural_summary` | Unused: objects without a SQL body (tables, external objects) get no hop | Reduced capture structure: Purpose, Upstream sources and Downstream consumers |
| `column_trace_capture` | Each column-trace hop that carries column work | How column provenance is explained |
| `summary`, `title`, `intro`, `closing` | Final report | Info card line, title, opening and closing (`closing` is skipped below three detailed nodes) |
| `highlights`, `notes` | Final report | Highlight groups and per-node notes on the graph |
| `loading_pattern` | Final report of a technical or combined exploration | How load patterns are summarized |
| `general` | Final report | Section structure and rules for lists, tables, SQL fences and callouts |

### What the extension reads

- `instruction` replaces the built-in text; an empty one is ignored.
- `sections` (on `business_capture` and `technical_capture` only) is an optional ordered list of bold section labels; `{{sections}}` in `general` expands to them.
- `stages` and `example` are not read. Unknown keys are skipped with a warning; a key set to a plain string invalidates the whole file.

Common capture coverage lives in editable `shared_capture` metadata. Business and technical recipes add their audience-specific instructions. When both are selected, business is the main explanation and technical adds implementation detail; shared facts, formulas and deciding SQL are recorded once across the combined section strings. Selecting both does not concatenate two complete walkthroughs. The additive key uses the existing overlay merge and leaves `schemaVersion` unchanged.

Capture templates run under a fixed structural header you cannot override. Write each instruction to stand alone; do not refer to "above" or "below". Instructions replace presentation guidance, but cannot bypass consent, scope, identity checks or output schemas. Synthesis may rephrase hop findings, so wording needed in the final report belongs in a final-report key.

### Reload and check your changes

Templates load on activation and whenever `dataLineageViz.ai.outputTemplateFile` changes, so re-save the setting or reload the window after editing. **Output → Data Lineage Viz** logs `Applied AI templates:` with the keys taken from your file, and reports unknown keys, invalid `sections` and load failures. Then ask a question in chat and check the answer against the source SQL.

### Keep `schemaVersion` current

Your file must declare the same `schemaVersion` as [`assets/aiOutputTemplates.yaml`](../assets/aiOutputTemplates.yaml); otherwise the extension warns and uses the built-in templates. A breaking removal, rename or field-type change requires a new version; wording and additive changes do not. To upgrade, move your old file aside, run **Data Lineage: Create AI Output Templates** again, copy your `instruction` edits across and point the setting at the new file.

## How prompts are built

`@lineage` runs in stages (discovery, gate, one hop per SQL object, synthesis), each with its own prompt and tools. Stage prompts state the task, tool schemas own field contracts, and templates own presentation; a rule belongs in exactly one. See [Exploration](ARCHITECTURE.md#exploration).

One tool catalog serves every caller; seven read-only tools are also exposed to Copilot agent mode through the generated `languageModelTools` manifest in `package.json`.

### Hop memory

Discovery and follow-ups use ordinary conversation history. Each hop sends a stable system prefix (protocol, mission brief, original question, discovery summary) and a short per-hop message (focus object, arriving tasks, capture template, recent summaries and rejections). After each committed hop the thread restarts from one continuation message; findings are replayed once at synthesis.

On any safe held draft, the immediate job lists saved field names and fields to correct from the engine's current focus/hop/mode metadata. The latest tool error remains authoritative about each correction or alternative; a faulty field may need removal rather than a new value. Original qualified tasks remain reference context. Section completeness independently controls the writing recipe: omit section-writing recipes and their prose-format header only when all required angles are held; otherwise retain the recipe for missing or malformed text. SQL, neighboring metadata, memory and evidence guardrails remain. With no safe draft, the fresh authoring job remains. This changes the writing job, not classification, validation, native call/result history or the stable system prefix.

A hop gets CT instructions only when it carries column work; otherwise it runs as BB. Carried tasks keep qualified object and column endpoints and the traversal side, not bare column names. A function investigation keeps the caller SQL, the requested output and the function definition on every retry. Parameters are caller-binding context, not invented graph columns. An object dependency alone does not establish a column contribution, and valid identifiers do not prove a complete or correct SQL interpretation.

The hop message distinguishes assigned endpoints from unresolved candidates using existing qualified task identities. A directly assigned endpoint asks for its SQL-established relations; assignment alone does not claim a preceding mapping. A table forwards its question and qualified candidates automatically: downstream SQL establishes whether it uses a value, upstream SQL whether it writes a stored output. The same engine path handles added tables, merges purposes and endpoints before dispatch, and respects the approved border.

Each SQL hop submits findings, confirmed mappings and neighbor questions or prunes, without an analyze/passthrough choice. Forwarded endpoints remain candidates until executable SQL establishes a contribution. Unmapped candidates end on that branch: `lineage_submit_findings` uses the whole `column_flow: []` when none continues, retaining supported SQL findings in `sections`. An entry with `upstream_columns: []` instead retains an output with no recorded in-scope suppliers; it does not establish its SQL origin. Unresolved candidates require stated uncertainty rather than invented outputs or claimed finality. An assigned endpoint without a mapping ends at that hop; later object-only work stays BB. `storage_context` supplies the related table metadata and stored DDL without treating table definitions as loading SQL.

Only a SQL hop whose arriving work came through storage forwarding can receive `lineage_prune_current`. It takes `reason` and an optional `focus_node_id`; one reply evaluates one hop-completion command. Existing committed mappings and independent direct tasks remain protected. Explicit pruning removes an irrelevant branch, while ending a column continuation with kept findings retains the node.

BB and CT share the same validation and correction path, defined in the [architecture guide](ARCHITECTURE.md). In CT an arriving column without a mapping ends at that hop; the acknowledgement lists it as an ended column. Generated CT instructions describe accepted mappings alongside the AI's neighbor question.

One backend neighbor projection supplies the hop context and the BB/CT question and prune schemas. Questions are optional: the model asks a neighbor only what its SQL must answer beyond the column continuation, which the engine generates for mapped neighbors. Eligible out-of-scope questions remain optional follow-ups. Column references may still use visited neighbors as evidence; schemas do not offer them new actions. A column contribution's optional note is a short clause naming that source column's contribution and is valid only inside an `upstream_columns` entry; explanation about the output itself belongs in sections. A misplaced key is rejected with one `field_not_allowed` detail per key, naming its concrete path and the fields the schema allows there.

Rejections retain valid content and identify the reported faulty fields. Findings send only corrected fields, including held fields when replacing them resolves a stated alternative. A faulty `column_flow` is sent again whole; every other field that validates is held. Valid mappings involved only in a prune conflict stay held when the conflicting action is corrected; they need not be resent. After rejection, the instructions request only corrections; valid content stays held. The retry schema preserves ordinary known fields and their strict types, so a valid full resend remains legal. The complete merged finding is revalidated before traversal continues. A complete sent list replaces it whole. Omitted valid lists stay held, an omitted faulty optional field is withdrawn, and explicit `[]` withdraws a list. A mapped neighbor cannot also be pruned, including contextual or filter mappings and held decisions. Reports repair section fields by index: label, text, node_ids, or a preview's start block. Highlight labels also use indexed repair; structural section and note changes use keyed entries. Valid bodies, other fields and ordering stay held. Preview schema failures and later merged-report failures use the same repair path; malformed repairs keep the draft. Empty arguments request the required repair fields rather than regeneration of the report.

The CT capture instruction prioritizes value flow for qualified task outputs. A `transforms` list that contains only `combine` or `filter` is accepted and stored as an indirect edge; the schema does not require a direct role. Join, filter, grouping, partition and ordering roles do not by themselves establish an arithmetic or aggregate value input. Instructions distinguish direct value lineage from indirect dependencies and retain SQL-supported dataset effects in memory and presentation even when no column-value edge represents them. Keep requested or assigned output mappings when dependencies or destinations lie beyond the requested trace limit. Record all supported in-scope value inputs; `combine` and `filter` are valid on their own, and `transforms` stays optional. At a procedure, `writes_to` is required: send `null` for a known outside write, and retain the SQL facts and unresolved evidence in `sections`. `writes_to: null` means the output has no neighbor table write. Whole `column_flow: []` records no mapped outputs. Graph endpoints and topology-derived source candidates do not establish complete SQL provenance; synthesis uses the retained findings to describe their dependencies.

Model-facing tool feedback uses the existing JSON rejection envelope. The first correction names every independent fault, its path, and a short correction, and withholds the form allowed list; its reason or hint can still name committed labels or accepted ids. The last available correction adds relevant structured values and alternatives; it does not repeat the capture rules or inventories of valid content. With three attempts, only two corrections can be consumed before a terminal failure. Detailed issue facts remain local. One rejection reports all independently decidable schema and state faults; malformed fields block dependent checks rather than supplying invented empty values. The engine owns legal action constraints, and the shared renderer preserves those facts without adding SQL interpretation or a second repair policy. Eligible neighbor questions remain AI-authored and required target accounting still applies. Missing-call feedback names the required delivery channel. Invalid submissions remain rejected; the backend neither commits reduced mappings nor generates questions. Reply budgets and rejection counters are unchanged. Diagnostic caps do not shorten correction information, and raw rejected payloads, held prose and local diagnostic bookkeeping stay out of the feedback projection. See the [architecture guide](ARCHITECTURE.md) for correction and stop rules.

Static SQL can suggest a performance pattern, but cannot establish actual index benefit, join strategy, parameter sniffing or statistics freshness without catalog or runtime evidence. Custom templates cannot give the assistant evidence absent from the loaded model.

## Change a prompt or tool description

When refining a prompt or tool description:

- Make the smallest change where the behavior is owned: stage prompt, tool schema or template.
- After changing a tool description or schema, run `npm run generate:tool-manifest` so `package.json` matches the catalog.
- For a breaking removal, rename or field-type change, update `schemaVersion` in the YAML and in `src/ai/session/types.ts` together.
- Run `npm run test:runtime` and `npm run gate`.
- For a change in model behavior, compare baseline and candidate answers across evaluation runs.

### Where to change it

Templates: `assets/aiOutputTemplates.yaml`. Stage prompts: `src/ai/prompting/`, assembled in `src/ai/agent/`. Tools, schemas and phase policy: `src/ai/tools/`.
