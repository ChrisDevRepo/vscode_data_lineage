# AI Output Templates

Customize how the `@lineage` chat participant formats its analysis views.

## Quick Start

1. **Command Palette** (`Ctrl+Shift+P`) > **Data Lineage: Create AI Output Templates** -- copies the built-in YAML to your workspace
2. **Settings** (`Ctrl+,`) > search `dataLineageViz.ai.outputTemplateFile` > set to the YAML filename
3. Edit the `instruction` fields -- changes take effect on the next `@lineage` conversation

## How It Works

The YAML file defines five output fields. Only the `instruction` value of each field is injected into the AI prompt. The `example`, `bad_example`, and `good_example` values are for you -- they help you understand what each field should produce.

```
aiOutputTemplates.yaml
  ├── summary.instruction      → injected into system prompt (rule 5)
  ├── description.instruction  → injected into system prompt (rule 5)
  ├── badges.instruction       → injected into enrich_view tool description
  ├── highlights.instruction   → injected into enrich_view tool description
  └── notes.instruction        → injected into enrich_view tool description
```

## The Five Fields -- A Layered Hierarchy

The fields work together like a magazine article about a diagram:

| Layer | Field | Role | Where shown |
|-------|-------|------|-------------|
| **Headline** | `summary` | One-line purpose (max 120 chars) | Info card |
| **Callouts** | `badges` | Numbered step markers on 5-8 key nodes | On graph nodes |
| **Captions** | `notes` | One-line role of each badged node | Below graph nodes |
| **Article** | `description` | Full step-by-step answer referencing badge numbers | Expandable overlay |
| **Emphasis** | `highlights` | Color glow on 2-3 critical nodes | Graph node borders |

**Badges** are numbered navigation anchors (e.g., "1 Source", "3 FX Convert"). **Notes** caption each badged node so the graph alone tells the story. **Description** is the deep read -- each `##` heading references badge step numbers to connect text to graph.

## YAML Format

```yaml
# Only 'instruction' is injected into the AI prompt.
# example / bad_example / good_example are documentation for you.

summary:
  instruction: >
    One-line graph purpose (max 120 chars). Shown in the info card.
  example: "Revenue lineage from SAP invoices through EV calculation to FactFinance."

description:
  instruction: >
    The detailed answer -- structured markdown with ## headings.
    Each heading covers one or more badge steps: "## Revenue Calculation (steps 3-4)".
    Under each heading, explain the business logic -- formulas, column mappings, WHY it matters.
    The graph shows structure; you explain meaning.
    Supported: ## headings, **bold**, `code`, lists, | tables |, LaTeX ($inline$ / $$block$$), code blocks.
    Not supported: mermaid, HTML, images, footnotes.
  bad_example: "Data flows from staging through transformation to consumption."
  good_example: |
    ## Revenue Calculation (steps 3-4)
    Revenue uses **Earned Value methodology**:
    $$Revenue = PlannedValue \times \frac{EarnedHours}{PlannedHours}$$
    `spCalcEV` (step 3) reads `DimProject.PlannedValue` and `FactTimesheet.Hours`,
    then `vw_Revenue` (step 4) applies the Swiss filter: `WHERE CountryCode = 'CH'`.

badges:
  instruction: >
    Numbered navigation anchors on 5-8 KEY nodes -- not every node.
    Format: "1 Source", "3 FX Convert". Number = logical step in the description.
    Only badge a node if the description explains what happens there.

highlights:
  instruction: >
    Glow 2-3 critical nodes only. Pick ONE scheme:
    Lineage (source/transform/target) or Diagnostic (good/warn/fail).

notes:
  instruction: >
    One-line caption under each BADGED node -- what it does in this flow.
    First line visible, rest on hover via \n.
  example: "Aggregates monthly invoices\nSELECT SUM(Amount) GROUP BY Month FROM Invoices"
```

## Writing Effective Instructions

These tips apply to any `instruction` field you customize.

| Tip | Why |
|-----|-----|
| **State what, not how** | The AI knows markdown -- tell it what content you want, not how to format it |
| **Include BAD/GOOD contrast** | Models follow examples more reliably than rules ([Anthropic](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/be-direct)) |
| **Keep under 3 sentences** | Longer instructions get partially ignored; move details to `good_example` |
| **Explain WHY** | "The graph shows structure; you explain meaning" works better than "don't describe topology" |
| **Reference other fields** | "Reference badge step numbers in ## headings" connects the hierarchy |

### Audience Adaptation

Edit the `description.instruction` to match your audience:

| Audience | Instruction style |
|----------|-------------------|
| **Senior engineer** | "Concise. Column mappings and formulas only. No basics." |
| **Junior analyst** | "Step-by-step. Explain what each SP does and what SQL patterns mean." |
| **Manager** | "Business language. No SQL. Focus on what the numbers mean." |
| **DBA / compliance** | "Technical detail. Include data types, constraints, audit trail." |

## What You Can vs Cannot Customize

The YAML controls the **presentation layer** only — how the AI formats its final output to you. Everything upstream (discovery, routing, state machine protocol, anti-hallucination guards) is hardcoded for correctness.

| Layer | Customizable? | Mechanism | Examples |
|-------|:---:|-----------|----------|
| **Output formatting** (enrich_view) | **Yes — YAML** | `aiOutputTemplates.yaml` | Summary length, description style, badge count, audience tone |
| System prompt (rules 1-4) | No — hardcoded | `extension.ts` | "Never fabricate IDs", validation stops, routing logic |
| Mode prompts (CT/BB) | No — hardcoded | `extension.ts` | Verdict instructions, column tracking, findings format |
| Tool descriptions | No — hardcoded | `package.json` | When/what/format for each tool |
| State machine protocol | No — hardcoded | `columnTraceState.ts`, `blackboardState.ts` | Goal anchors, boundary detection, memory tiers |
| Token budget gate | No — hardcoded | `tokenBudget.ts` | Inline vs state machine delivery |

**Why this boundary?** A power user changing "use numbered steps" → "use bullet points" is a style preference that cannot break correctness. A power user changing "NEVER fabricate IDs" would introduce hallucination risk. The YAML controls the final mile; the code controls everything that feeds it.

## VS Code Settings

| Setting | Default | Purpose |
|---------|---------|---------|
| `dataLineageViz.ai.enabled` | `true` | Enable/disable the `@lineage` chat participant |
| `dataLineageViz.ai.outputTemplateFile` | *(empty)* | Path to custom YAML (relative to workspace root) |
| `dataLineageViz.ai.maxRounds` | `25` | Max tool-call rounds per request. Increase for complex column traces. |

No per-tool caps — the extension delivers full data. Token estimation (`shouldInline`) decides delivery mode (inline vs state machine).

## Failsafe Chain

Same pattern as [Parse Rules](PARSE_RULES.md) and [DMV Queries](DMV_QUERIES.md):

1. Custom YAML file (from `outputTemplateFile` setting)
2. Validate: all 5 required keys (`summary`, `description`, `badges`, `highlights`, `notes`) present with non-empty `instruction`
3. Missing keys: warn in Output channel, use built-in default for that key
4. Custom file fails entirely: warn, fall back to built-in `assets/aiOutputTemplates.yaml`
