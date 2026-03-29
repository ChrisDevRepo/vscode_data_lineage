# AI Output Templates

The `@lineage` chat participant creates views with five output fields: **summary**, **description**, **badges**, **highlights**, and **notes**. Each field has an instruction that tells the AI what to write. Customize these instructions to change the AI's output style.

## Setup

1. Open the **Command Palette** (`Ctrl+Shift+P`) and run **Data Lineage: Create AI Output Templates** -- this copies the built-in YAML into your workspace as `aiOutputTemplates.yaml`
2. Set `dataLineageViz.ai.outputTemplateFile` to `aiOutputTemplates.yaml` in VS Code Settings (`Ctrl+,`, search "dataLineageViz")
3. Edit the `instruction` fields in the YAML to change how the AI formats its output
4. Changes take effect on the next `@lineage` conversation (no reload needed)

## Two Layers: Visual + Analytical

The AI view has two complementary layers that should not duplicate each other:

| Layer | Fields | Shows |
|-------|--------|-------|
| **Visual** (graph) | badges, highlights, notes | Structure -- what connects to what, step order, node roles |
| **Analytical** (overlay) | summary, description | Meaning -- business logic, formulas, column mappings |

The graph shows structure. The description explains meaning.

## Field Reference

### summary
One-line graph purpose shown in the info card (max 120 chars).

**Example:** "Revenue lineage from SAP invoices through EV calculation to FactFinance."

### description
Full structured answer shown in the expandable overlay. Supports markdown: headings, lists, tables, code blocks, LaTeX math (`$formula$`).

**Good:** Explains business logic, formulas, column-level mappings. References badges/highlights.
```
## Revenue Calculation
Revenue uses the **Earned Value (EV) methodology**:
$$Revenue = PlannedValue \times \frac{EarnedHours}{PlannedHours}$$

`spCalcEV` (badge 3) reads `DimProject.PlannedValue` and `FactTimesheet.Hours`...
```

**Bad:** Re-describes the graph topology (the user can already see that).
```
Data flows from staging through transformation to consumption.
```

### badges
Numbered step labels on nodes (e.g., "1 Source", "2 Load", "3 Calc"). Plain text.

### highlights
Glow on 2-3 critical nodes. One scheme per view: **Lineage** (source/transform/target) or **Diagnostic** (good/warn/fail).

### notes
Short plain text below each node. First line visible, rest on hover via `\n`.

**Example:** `"Aggregates monthly invoices\nSELECT SUM(Amount) GROUP BY Month"`

## Audience Adaptation

Edit the `instruction` fields to match your audience:

| Audience | Description instruction style |
|----------|------------------------------|
| **Senior engineer** | "Concise. Column mappings and formulas only. No basics." |
| **Junior analyst** | "Step-by-step. Explain what each SP does and what SQL patterns mean." |
| **Manager** | "Business language. No SQL. Focus on what the numbers mean." |
| **DBA/compliance** | "Technical detail. Include data types, constraints, audit trail." |

## Failsafe Chain

Same pattern as [Parse Rules](PARSE_RULES.md) and [DMV Queries](DMV_QUERIES.md):

1. Custom YAML file (if setting points to one)
2. Validate: required keys present and non-empty
3. Missing keys: warn in Output channel, use built-in default for that key
4. Custom file fails entirely: warn, fall back to built-in `assets/aiOutputTemplates.yaml`

## YAML Format

```yaml
summary:
  instruction: "One-line graph purpose (max 120 chars)."
  example: "Revenue lineage from SAP invoices through EV calculation to FactFinance."

description:
  instruction: "Your full answer -- structured markdown with formulas and column mappings."
  bad_example: "Data flows from staging through transformation to consumption."
  good_example: |
    ## Revenue Calculation
    Revenue uses EV methodology: $Revenue = PV \times EH/PH$

badges:
  instruction: "Numbered step labels (1 Source, 2 Load, 3 Calc). Plain text."

highlights:
  instruction: "Glow 2-3 critical nodes. ONE scheme only."

notes:
  instruction: "Short text below each node. First line visible, rest on hover."
  example: "Aggregates monthly invoices\nSELECT SUM(Amount) GROUP BY Month"
```

Only the `instruction` fields are injected into the AI prompt. The `example`, `bad_example`, and `good_example` fields are documentation for you -- they help you understand what each field does.
