# AI prompts and output templates

How to change how `@lineage` writes answers, and where its prompts live in a clone. Hops, BB and CT are explained in [Architecture](ARCHITECTURE.md#exploration).

## Customize output templates

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

Common capture coverage lives in `shared_capture`. When business and technical angles are both selected, business is the main explanation and technical adds implementation detail; shared facts, formulas and deciding SQL are recorded once.

Capture templates run under a fixed structural header you cannot override. Write each instruction to stand alone; do not refer to "above" or "below". Instructions replace presentation guidance, but cannot bypass consent, scope, identity checks or output schemas. Synthesis may rephrase hop findings, so wording needed in the final report belongs in a final-report key.

### Reload and check your changes

Templates load on activation and whenever `dataLineageViz.ai.outputTemplateFile` changes, so re-save the setting or reload the window after editing. **Output → Data Lineage Viz** logs `Applied AI templates:` with the keys taken from your file, and reports unknown keys, invalid `sections` and load failures. Then ask a question in chat and check the answer against the source SQL.

### Keep `schemaVersion` current

Your file must declare the same `schemaVersion` as [`assets/aiOutputTemplates.yaml`](../assets/aiOutputTemplates.yaml); otherwise the extension warns and uses the built-in templates. A breaking removal, rename or field-type change requires a new version; wording and additive changes do not. To upgrade, move your old file aside, run **Data Lineage: Create AI Output Templates** again, copy your `instruction` edits across and point the setting at the new file.

## Change a prompt or tool description

Templates: `assets/aiOutputTemplates.yaml`. Stage prompts: `src/ai/prompting/`, assembled in `src/ai/agent/`. Tools, schemas and phase policy: `src/ai/tools/`. Change the owner of the behavior: stage prompts state the task, tool schemas own field contracts and templates own presentation.

After changing a tool description or schema, run `npm run generate:tool-manifest` so `package.json` matches the catalog. For a breaking removal, rename or field-type change, update `schemaVersion` in the YAML and in `src/ai/session/types.ts` together. Run `npm run test:runtime` and `npm run gate`; the gate fails until the model-visible manifest is regenerated for changed prompt text (`node tests/tools/run-vitest.mjs run tests/unit/ai-core/model-visible-requests.test.ts -u`).

Static SQL can suggest a performance pattern, but cannot establish actual index benefit, join strategy, parameter sniffing or statistics freshness; custom templates cannot give the assistant evidence absent from the loaded model.
