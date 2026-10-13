# AI prompts and output templates

The first part is for users who change how `@lineage` writes answers; the second is for anyone changing the prompts in a clone. Hops, BB and CT are explained in [Architecture](ARCHITECTURE.md#exploration).

## Customize output templates

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
| `structural_summary` | Each hop on a table or external object | The short record for an object without a SQL body |
| `column_trace_capture` | Each column-trace hop that carries column work | How column provenance is explained |
| `summary`, `title`, `intro`, `closing` | Final report | Info card line, title, opening and closing (`closing` is skipped below three detailed nodes) |
| `highlights`, `notes` | Final report | Highlight groups and per-node notes on the graph |
| `loading_pattern` | Final report of a technical or combined exploration | How load patterns are summarized |
| `general` | Final report | Section structure and rules for lists, tables, SQL fences and callouts |

### What the extension reads

- `instruction` replaces the built-in text; an empty one is ignored.
- `sections` (on `business_capture` and `technical_capture` only) is an optional ordered list of bold section labels; `{{sections}}` in `general` expands to them.
- `stages` and `example` are not read. Unknown keys are skipped with a warning; a key set to a plain string invalidates the whole file.

Capture templates run under a fixed header you cannot override. Write each instruction to stand alone; do not refer to "above" or "below".

### Reload and check your changes

Templates load on activation and whenever `dataLineageViz.ai.outputTemplateFile` changes, so re-save the setting or reload the window after editing. **Output → Data Lineage Viz** logs `Applied AI templates:` with the keys taken from your file, and reports unknown keys, invalid `sections` and load failures. Then ask a question in chat and check the answer against the source SQL.

### Keep `schemaVersion` current

Your file must declare the same `schemaVersion` as [`assets/aiOutputTemplates.yaml`](../assets/aiOutputTemplates.yaml); otherwise the extension warns and uses the built-in templates. The version changes only when a key or field is removed or renamed. To upgrade, move your old file aside, run **Data Lineage: Create AI Output Templates** again, copy your `instruction` edits across and point the setting at the new file.

## How prompts are built

`@lineage` runs in stages (discovery, gate, one hop per object, synthesis), each with its own prompt and tools. Stage prompts state the task, tool schemas own field contracts, and templates own presentation; a rule belongs in exactly one. See [Exploration](ARCHITECTURE.md#exploration).

One tool catalog serves every caller; seven read-only tools are also exposed to Copilot agent mode through the generated `languageModelTools` manifest in `package.json`.

### Hop memory

Discovery and follow-ups use ordinary conversation history. Each hop sends a stable system prefix (protocol, mission brief, original question, discovery summary) and a short per-hop message (focus object, arriving tasks, capture template, recent summaries and rejections). After each committed hop the thread restarts from one continuation message; findings are replayed once at synthesis.

A hop gets CT instructions only when it carries column work; otherwise it runs as BB. Carried tasks keep qualified object and column endpoints and the traversal side, not bare column names. A function investigation keeps the caller SQL, the requested output and the function definition on every retry.

## Change a prompt or tool description

Follow the [prompt-change workflow](../.agents/skills/prompt-change/SKILL.md). In short:

- Make the smallest change where the behavior is owned: stage prompt, tool schema or template.
- After changing a tool description or schema, run `npm run generate:tool-manifest` so `package.json` matches the catalog.
- After removing or renaming a template key or field, raise `schemaVersion` in the YAML and in `src/ai/session/types.ts` together.
- Run `npm run test:runtime` and `npm run gate`.
- For a change in model behavior, compare baseline and candidate answers with the [prompt-playground workflow](../.agents/skills/prompt-playground/SKILL.md).

### Where to change it

Templates: `assets/aiOutputTemplates.yaml`. Stage prompts: `src/ai/prompting/`, assembled in `src/ai/agent/`. Tools, schemas and phase policy: `src/ai/tools/`.
