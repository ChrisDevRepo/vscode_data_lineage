# AI Output Templates

Customize how the `@lineage` chat participant formats its analysis views.

## Quick Start

1. **Command Palette** (`Ctrl+Shift+P`) > **Data Lineage: Create AI Output Templates** -- copies the built-in YAML to your workspace
2. **Settings** (`Ctrl+,`) > search `dataLineageViz.ai.outputTemplateFile` > set to the YAML filename
3. Edit the `instruction` fields -- changes take effect on the next `@lineage` conversation

## How It Works

The YAML file defines six output fields. Only the `instruction` value of each field is injected into the AI prompt. The `example`, `bad_example`, and `good_example` values are for you -- they help you understand what each field should produce.

```
aiOutputTemplates.yaml
  ├── summary.instruction      → injected into system prompt (rule 5)
  ├── description.instruction  → injected into system prompt (rule 5)
  ├── badges.instruction       → injected into enrich_view tool description
  ├── sections.instruction     → injected into enrich_view tool description
  ├── highlights.instruction   → injected into enrich_view tool description
  └── notes.instruction        → injected into enrich_view tool description
```

## The Label-Section Data Contract

The key mechanism is a **label join key** between badges and sections:

```
badges: [                           sections: [
  { node_id: "dbo.Raw",             ← label must match badge.text exactly
    text:    "Source" },               { label: "Source",
  { node_id: "dbo.Raw2",                 text:  "Raw and Raw2 are..." },
    text:    "Source" },            ← same label → grouped under one heading
  { node_id: "dbo.SP1",
    text:    "ETL"   },                { label: "ETL",
]                                        text:  "SP1 joins..." },
                                    ]
                         ↓
System assigns numbers, orders by data-flow, assembles:
  ## 1 Source          ← badge "1 Source" on both dbo.Raw and dbo.Raw2
  Raw and Raw2 are...
  ## 2 ETL             ← badge "2 ETL" on dbo.SP1
  SP1 joins...
```

**Rules:**
- `section.label` must exactly match `badge.text` (case-sensitive, no leading numbers)
- Same label on multiple badges → one section, same step number on all those nodes
- Not every node needs a badge — only the ones you chose to explain
- Badge without a section → allowed (just a label chip, no heading generated)
- Section without a matching badge → rejected by validation

## The Six Fields

| Layer | Field | Role | Where shown |
|-------|-------|------|-------------|
| **Headline** | `summary` | One-line purpose (max 120 chars) | Info card |
| **Callouts** | `badges` | Semantic labels on key nodes (system adds step numbers) | On graph nodes |
| **Detail** | `sections` | One markdown block per badge label — findings, logic, issues | Description overlay |
| **Captions** | `notes` | One-line caption per node — visible below node, rest on hover | Below graph nodes |
| **Emphasis** | `highlights` | Color glow on 2-3 critical nodes | Graph node borders |
| **Fallback** | `description` | Freeform markdown — used only when sections[] is absent | Description overlay |

**Badges** carry semantic labels (e.g. "Source", "ETL", "Target"). **Sections** explain what you found at each labeled group — the AI writes one section per unique label. **System** assigns step numbers, orders by data-flow, and assembles `## N Label` headings. **Notes** caption individual nodes. **Description** is a fallback when sections are not provided.

## YAML Format

```yaml
# Only 'instruction' is injected into the AI prompt.
# example / bad_example / good_example are documentation for you.

summary:
  instruction: >
    One-line graph purpose (max 120 chars). Shown in the info card.
  example: "Revenue lineage from SAP invoices through EV calculation to FactFinance."

badges:
  instruction: >
    Semantic labels on nodes you analyzed -- no numbers (system assigns step numbers).
    Same label on multiple nodes groups them under one section heading.
    One label per logical group, as many groups as needed.
    Badge every node that appears in your sections -- section.label must match badge.text exactly (join key).
    BAD: "3 Source" (number in label), badges with no matching section.
    GOOD: "Source" on 2 raw tables, "ETL" on 3 SPs -- each covered by a section.

sections:
  instruction: >
    One entry per unique badge label -- explains what you found at those nodes.
    label: must exactly match a badge text value (join key, case-sensitive).
    text: markdown explaining findings — question-adapted: business meaning for logic/column questions, execution patterns for performance, both for documentation. Formulas, column mappings, risk flags.
    System orders by data-flow depth and assembles ## headings with step numbers.
    Reference other groups by label name ("reads from **Source**"), never by number.
    Supported in text: **bold**, `code`, tables, $math$, ```math blocks.
  example: '{ "label": "FX Convert", "text": "`spConvertFX` multiplies Amount by DimRate.Rate\nJoins FactSales.CurrencyKey -> DimRate.CurrencyKey" }'

highlights:
  instruction: >
    Glow 2-3 critical nodes only. Pick ONE scheme:
    Lineage (source/transform/target) or Diagnostic (good/warn/fail).

notes:
  instruction: >
    One-line caption under each node -- what it does in this flow.
    First line visible, rest on hover via \n.
  example: "Aggregates monthly invoices\nSELECT SUM(Amount) GROUP BY Month FROM Invoices"

description:
  instruction: >
    Fallback only -- used when sections[] is not provided. Prefer sections[].
    Structured markdown with ## headings. Explain what you found -- logic, patterns, issues.
    Supported: ## headings, **bold**, `code`, tables, LaTeX ($inline$, ```math blocks).
    Not supported: mermaid, HTML, images, footnotes.
  bad_example: "Data flows from staging through transformation to consumption."
  good_example: |
    ## Revenue Calculation
    Revenue uses **Earned Value methodology**:
    ```math
    Revenue = PlannedValue \times \frac{EarnedHours}{PlannedHours}
    ```
    `spCalcEV` reads `DimProject.PlannedValue` and `FactTimesheet.Hours`,
    then `vw_Revenue` applies the Swiss filter: `WHERE CountryCode = 'CH'`.
```

## Writing Effective Instructions

These tips apply to any `instruction` field you customize.

| Tip | Why |
|-----|-----|
| **State what, not how** | The AI knows markdown -- tell it what content you want, not how to format it |
| **Include BAD/GOOD contrast** | Models follow examples more reliably than rules ([Anthropic](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/be-direct)) |
| **Keep under 3 sentences** | Longer instructions get partially ignored; move details to `good_example` |
| **Explain WHY** | "The graph shows structure; you explain meaning" works better than "don't describe topology" |
| **Reference other fields** | "Reference badge label names in section text" connects the data contract |

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
| System prompt (rules 1-5) | No — hardcoded | `prompts.ts` | "Never fabricate IDs", validation stops, routing logic |
| Mode prompts (CT/BB) | No — hardcoded | `prompts.ts` | Verdict instructions, column tracking, findings format |
| Tool descriptions | No — hardcoded | `package.json` | When/what/format for each tool |
| State machine protocol | No — hardcoded | `columnTraceState.ts`, `blackboardState.ts` | Goal anchors, boundary detection, memory tiers |

**Why this boundary?** A power user changing "use numbered steps" → "use bullet points" is a style preference that cannot break correctness. A power user changing "NEVER fabricate IDs" would introduce hallucination risk. The YAML controls the final mile; the code controls everything that feeds it.

## VS Code Settings

| Setting | Default | Purpose |
|---------|---------|---------|
| `dataLineageViz.ai.enabled` | `true` | Enable/disable the `@lineage` chat participant |
| `dataLineageViz.ai.maxRounds` | `50` | Max tool-call rounds per request. Increase for complex column traces. |
| `dataLineageViz.ai.inlineTokenBudget` | `10000` | Token threshold for quick vs deep analysis. Both this AND `inlineNodeCap` must be within limits for quick mode. |
| `dataLineageViz.ai.inlineNodeCap` | `10` | Node count threshold for quick vs deep analysis. Scopes with more nodes use hop-by-hop with persistent memory. |
| `dataLineageViz.ai.outputTemplateFile` | *(empty)* | Path to custom YAML (relative to workspace root) |

No per-tool caps — the extension delivers full data. Small scopes (≤10 nodes AND under token budget) use quick inline delivery. Larger scopes use hop-by-hop exploration with persistent memory for deeper column tracking.

## Failsafe Chain

Same pattern as [Parse Rules](PARSE_RULES.md) and [DMV Queries](DMV_QUERIES.md):

1. Custom YAML file (from `outputTemplateFile` setting)
2. Validate: all 6 required keys (`summary`, `description`, `badges`, `sections`, `highlights`, `notes`) present with non-empty `instruction`
3. Missing keys: warn in Output channel, use built-in default for that key
4. Custom file fails entirely: warn, fall back to built-in `assets/aiOutputTemplates.yaml`
