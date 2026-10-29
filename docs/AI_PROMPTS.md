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

Corrections append the native assistant/tool exchange to the original hop request. The system instruction, hop task, capture recipe and served tools stay as the original prefix; retries do not rebuild context or list held-content inventories. Feedback names the faulty fields and alternatives to resend. The backend validates the candidate against current metadata before accepting it.

A hop gets CT instructions only when it carries column work; otherwise it runs as BB. Carried tasks keep qualified object and column endpoints and the traversal side, not bare column names. A function investigation keeps the caller SQL, the requested output and the function definition on every retry. Parameters are caller-binding context, not invented graph columns. An object dependency alone does not establish a column contribution, and valid identifiers do not prove a complete or correct SQL interpretation.

The hop message distinguishes assigned endpoints from unresolved candidates using existing qualified task identities. A directly assigned endpoint asks for its SQL-established relations; assignment alone does not claim a preceding mapping. A table forwards its question and qualified candidates automatically: downstream SQL establishes whether it uses a value, upstream SQL whether it writes a stored output. The same engine path handles added tables, merges purposes and endpoints before dispatch, and respects the approved border.

Each SQL hop submits findings, confirmed mappings and neighbor questions or prunes, without an analyze/passthrough choice. Forwarded endpoints remain candidates until executable SQL establishes a contribution. Unmapped candidates end on that branch: `lineage_submit_findings` uses the whole `column_flow: []` when none continues, retaining supported SQL findings in `sections`. An entry with `upstream_columns: []` instead retains an output with no recorded in-scope suppliers; it does not establish its SQL origin. Unresolved candidates require stated uncertainty rather than invented outputs or claimed finality. An assigned endpoint without a mapping ends at that hop; later object-only work stays BB. `storage_context` supplies the related table metadata and stored DDL without treating table definitions as loading SQL.

Only a SQL hop whose arriving work came through storage forwarding can receive `lineage_prune_current`. It takes `reason` and an optional `focus_node_id`; one reply evaluates one hop-completion command. Existing committed mappings and independent direct tasks remain protected. Explicit pruning removes an irrelevant branch, while ending a column continuation with kept findings retains the node.

BB and CT share the same validation and correction path, defined in the [architecture guide](ARCHITECTURE.md). In CT an arriving column without a mapping ends at that hop; the acknowledgement lists it as an ended column. Generated CT continuation questions name metadata endpoints only; active prompts and schemas own mapping instructions.

One backend neighbor projection supplies the hop context and the BB/CT question and prune schemas. Questions are optional: the model asks a neighbor only what its SQL must answer beyond the column continuation, which the engine generates for mapped neighbors. Eligible out-of-scope questions remain optional follow-ups. Column references may still use visited neighbors as evidence; schemas do not offer them new actions. A column contribution's optional note is a short clause naming that source column's contribution and is valid only inside an `upstream_columns` entry; explanation about the output itself belongs in sections. A misplaced key rejects as `unknown_key` at its concrete path.

One shared draft holds valid fields for findings and reports. A correction normally sends only faulty fields, but valid held fields may be resent: identical values are no-ops and changed values replace the held copy. The full field schema stays available. Sent lists, including `column_flow`, report sections, highlights and notes, replace whole; no keyed or indexed patch grammar exists. Only object leaves previously named by feedback may be corrected individually. Omitted valid fields stay held, `null` withdraws an optional field, and `[]` empties a list where its schema allows it. A faulty overwrite keeps the prior valid value and reports that it could not be overwritten, without echoing either value. Valid mappings involved only in a prune conflict stay held while the action is corrected. One composed candidate is validated before traversal or presentation commits.

CT instructions record each SQL-proved output related to the arriving columns, including downstream fanout. A `transforms` list that contains only `combine` or `filter` is accepted and stored as an indirect edge; the schema does not require a direct role. Join, filter, grouping, partition and ordering roles do not by themselves establish an arithmetic or aggregate value input. Instructions distinguish direct value lineage from indirect dependencies and retain SQL-supported dataset effects in memory and presentation even when no column-value edge represents them. Keep requested or assigned output mappings when dependencies or destinations lie beyond the requested trace limit. Record all supported in-scope value inputs; `combine` and `filter` are valid on their own, and `transforms` stays optional. At a procedure, `writes_to` is required: send `null` for a known outside write, and retain the SQL facts and unresolved evidence in `sections`. `writes_to: null` means the output has no neighbor table write. Whole `column_flow: []` records no mapped outputs. Graph endpoints and topology-derived source candidates do not establish complete SQL provenance; synthesis uses the retained findings to describe their dependencies.

Model-facing rejections use one flat `{code, errors: [{path, code, message, allowed?}], resend}` problem, with an attempt marker and a last-correction notice. Feedback 1 names every independently decidable fault and a short correction; feedback 2 adds complete allowed values. Feedback 3 adds the detail-memory fallback only for rejected report object or column references: correct the reference, or preserve the information in detail text with an AI-authored callout naming the unresolved issue. Read/start arguments, text, missing content and control decisions get no fallback. Three corrections follow the initial reply (four replies total), then the hop terminates; failed synthesis retains its authored answer with a preview-failure notice. Malformed fields block dependent checks without inventing empty values. Fault messages come from one issue table; submitted values, held prose and diagnostic details are not echoed. See the [architecture guide](ARCHITECTURE.md) for commit boundaries.

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
