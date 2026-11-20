# AI Prompting And Templates

`@lineage` writes its answers from instructions stored in a YAML file,
[`assets/aiOutputTemplates.yaml`](../assets/aiOutputTemplates.yaml). This
document explains how to create a copy of that file, what can be changed in it
and how to keep a copy working after an upgrade.

The template controls the wording the model is asked to follow. The steps,
the tools the model can call and the structure of the final document are set by
the extension. The model's reading of the SQL is best-effort and can be
incomplete or wrong.

## Creating the template file

1. Run **Data Lineage: Create AI Output Templates** from the Command Palette.
   This copies the built-in file to `aiOutputTemplates.yaml` in the first
   workspace folder. If the file already exists, it is opened instead.
2. Set `dataLineageViz.ai.outputTemplateFile` to the file path (absolute, or
   relative to the first workspace folder).
3. Reload the window after editing the file. The file is read when the
   extension starts and when the setting changes, not on each chat turn.

An empty setting uses the built-in templates. In a workspace that is not
trusted, a workspace-level value of the setting is ignored until the workspace
is trusted.

## Editing the file

Each key is a block. Only two fields are read:

| Field | Use |
| --- | --- |
| `instruction` | Text sent to the model for that key. A value replaces the built-in text of the key; it does not add to it. |
| `sections` | Only on `business_capture` and `technical_capture`. The ordered bold labels the recipe writes (see [Section labels](#section-labels)). |

`stages` and `example` are labels and samples for the reader. They are not
read, so editing them changes nothing and raises no warning. A key that is
missing from the file keeps its built-in text, so the file can hold only the
keys being changed. A key with a bare string instead of an `instruction` block
makes the overlay fail to load, and the built-in templates are used.

Keys by step:

| Step | Keys |
| --- | --- |
| First reply, no exploration | `discovery_chat` |
| Analysis of each object | `business_capture`, `technical_capture`, `shared_capture`, `structural_callouts`, `structural_summary`, `column_trace_capture` |
| Final document | `summary`, `title`, `intro`, `closing`, `highlights`, `notes`, `general`, `loading_pattern` |

Each key is used only at its own step:

- `business_capture` and `technical_capture` apply to an object that has a SQL
  body, according to whether the question is business, technical or both.
  `structural_summary` is used instead for an object without a SQL body, such
  as a table.
- `column_trace_capture` applies only to a column trace.
- `loading_pattern` applies only to technical or combined answers.
- `closing` is omitted for small results.
- The final document may rephrase or drop a sentence captured per object.
  Wording that must appear in the report belongs in a final-document key.

### What can be changed

The wording of every `instruction` and the `sections` label lists. The
extension builds the document title, section headings, numbering, graph
badges, object links and the column chain of a column trace itself; an
instruction that asks for a different structure does not change them.

Empty values are skipped. Keep each instruction self-contained: it should not
refer to another template by position ("above", "below").

### Example

Guidance for a junior DBA. The file keeps the scaffolded `schemaVersion` and
changes only the keys that carry the guidance.

```yaml
schemaVersion: 3
discovery_chat:
  instruction: "Write for a junior DBA: define each technical term the first time it appears."
business_capture:
  instruction: "For each object, add one sentence a junior DBA can act on."
closing:
  instruction: "End with a short list titled 'Tips for junior DBAs' with two practical tips drawn from this lineage."
```

### Section labels

`business_capture` and `technical_capture` take an optional `sections` list:
the ordered bold labels the recipe writes. In the final document the `general`
instruction names the labels of the active angle (business, technical, or both)
through the `{{sections}}` placeholder. A `sections` list replaces the built-in
list of its recipe, so copy the built-in list and insert the new label:

```yaml
technical_capture:
  sections: [Purpose, Rules and branches, Grain, Column mapping, Steps, Loading, Error handling, Operational checks, Gaps]
  instruction: "... 6. Error handling: ... 7. Operational checks: rerun safety and locks."
```

A `general` instruction that lists labels in its own text and has no
`{{sections}}` placeholder is sent as written. A `sections` value that is not a
non-empty list of labels is skipped with a warning in the output channel, and
the built-in list stays.

## Upgrading a custom overlay

A custom file is applied only when its `schemaVersion` equals the version the
installed release expects. The version changes whenever the shipped file adds,
removes, renames or retypes a key or field; a wording change does not.
Version 3 adds `shared_capture` and moves the grain and plan-evidence coverage
into it, so a version 2 file is rejected with the warning.

On a mismatch the extension shows a warning that names the expected version
and uses the built-in templates until the file is updated.

To move a customization forward:

1. Run **Data Lineage: Create AI Output Templates** to get a fresh copy. If
   `aiOutputTemplates.yaml` already exists in the workspace folder, rename or
   move it first.
2. Re-apply your edits to the new file, comparing against the previous copy.
   The built-in wording may already cover what the edit was for.
3. Point `dataLineageViz.ai.outputTemplateFile` at the new file, reload the
   window and check that the warning no longer appears.

Keeping only the changed keys in the file lets the other keys follow the
built-in text of each release.

## What is sent to the model

`@lineage` uses the model selected in VS Code. For a request, the model
receives:

- the user's prompt and the native `@lineage` chat history as text;
- the lineage metadata and SQL definitions returned by the read tools run on
  the loaded model.

The AI runtime does not connect to a database or run SQL. See
[`SECURITY.md`](../SECURITY.md) for what is read, run and sent.
