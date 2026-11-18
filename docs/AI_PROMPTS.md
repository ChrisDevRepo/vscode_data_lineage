# AI prompts and output templates

How to change how `@lineage` writes answers, and where its prompts live in a clone. Hops, BB and CT are explained in [Architecture](ARCHITECTURE.md#consent-gate-and-exploration). Exact prompt wording is in the code and in [`assets/aiOutputTemplates.yaml`](../assets/aiOutputTemplates.yaml), the source of truth for the template keys.

## What goes to the model

Per chat request `@lineage` sends the selected model your question, recent `@lineage` chat, the phase instructions, and the SQL or metadata its read tools return from the loaded model. Nothing else leaves the machine ([`SECURITY.md`](../SECURITY.md)). Templates only change instructions; they cannot change tool availability, validation, consent or scope rules.

## Customize output templates

Templates control the tone, structure and detail of answers, not which objects are visited or how results are validated.

1. Run **Data Lineage: Create AI Output Templates**. It copies the built-in templates to `aiOutputTemplates.yaml` in the first workspace folder.
2. Set `dataLineageViz.ai.outputTemplateFile` to that file (a relative path resolves against the first workspace folder).
3. Edit the `instruction` of the keys you want to change. Your file is merged over the built-in templates, so you can delete the rest.

| Stage | Keys | What they shape |
|---|---|---|
| Discovery chat | `discovery_chat` | Tone, structure and detail of chat answers |
| Per-hop capture | `business_capture`, `technical_capture` | What is recorded about an object with a SQL body |
| | `structural_callouts`, `structural_summary` | Warnings backed by the SQL; objects without a SQL body |
| | `column_trace_capture` | How column provenance is explained (column traces only) |
| Final report | `summary`, `title`, `intro`, `closing` | Info card line, title, opening, closing (`closing` is skipped for small results) |
| | `highlights`, `notes`, `loading_pattern`, `general` | Highlight groups, per-node notes, load patterns, section structure and list, table and SQL rules |

- `instruction` replaces the built-in text of its key; an empty one is ignored. An `instruction` does not add to the built-in text.
- `sections` (on `business_capture` and `technical_capture` only) is an optional ordered list of bold section labels; `{{sections}}` in `general` expands to the labels of the active angle. It replaces the built-in list, so copy that list and insert your label.
- `stages` and `example` are never read. A key set to a plain string, not a block with `instruction`, makes the whole file fail to load.
- Write each instruction to stand alone; do not refer to "above" or "below". Hop capture runs under an engine-owned header you cannot replace. Synthesis may rephrase captured sentences, so wording that must appear in the report belongs in a final-report key.

Example — guidance for a junior DBA. Keep the scaffolded `schemaVersion` and change only the `instruction` of the keys that carry the guidance; every other key keeps the built-in text:

```yaml
discovery_chat:
  instruction: "Write for a junior DBA: define each technical term the first time it appears."
business_capture:
  instruction: "For each object, add one sentence a junior DBA can act on."
closing:
  instruction: "End with a short list titled 'Tips for junior DBAs' with two practical tips drawn from this lineage."
```

### Reload and check

Templates load on activation and whenever `dataLineageViz.ai.outputTemplateFile` changes, so re-save the setting or reload the window after editing the file. **Output → Data Lineage Viz** logs `Applied AI templates:` with the keys taken from your file, and reports unknown keys and load failures. Then ask a question and check the answer against the source SQL.

### Keep `schemaVersion` current

Your file is applied only when its `schemaVersion` equals the one in the shipped file (`AI_TEMPLATE_SCHEMA_VERSION` in [`src/ai/session/types.ts`](../src/ai/session/types.ts)). On a mismatch the extension logs a warning naming the file and the expected version, and uses the built-in templates for that session. A release bumps the version only when a key is removed or renamed or a field is retyped; wording changes and added keys never bump it. To upgrade, run **Data Lineage: Create AI Output Templates** again for a fresh copy, re-apply your edits (the built-in wording may already cover them), and point the setting at it.

## Change a prompt or tool description

Templates: `assets/aiOutputTemplates.yaml`. Phase prompts: [`src/ai/prompting/`](../src/ai/prompting/), assembled in [`src/ai/agent/`](../src/ai/agent/). Tools, schemas and phase policy: [`src/ai/tools/`](../src/ai/tools/) (`toolDefs.ts` is the catalog). Change the owner of the behavior: phase prompts state the task, tool schemas own field contracts, templates own presentation.

After changing a tool description or schema, run `npm run generate:tool-manifest` so `package.json` matches the catalog. After a breaking template change (a key removed, renamed or retyped), bump `schemaVersion` in the YAML and in `src/ai/session/types.ts` together; the gate step `assert-template-schema-version` compares against the last release tag. Run `npm run test:runtime` and `npm run gate`; these do not establish answer quality, so also review an answer and the graph in the Extension Development Host.

Static SQL can suggest a performance pattern but cannot establish index benefit, join strategy, parameter sniffing or statistics freshness; a template cannot give the assistant evidence absent from the loaded model.
