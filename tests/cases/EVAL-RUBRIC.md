# Eval Rubric — Output-Quality-First

This rubric supersedes hop-count / error-count metrics for grading `@lineage` eval runs. **Success is measured by the user-visible artifact (`enrich_view`) and the evidence in memory that backs it**, not by process metrics.

## Why not hop counts?

Hop counts, run times, and error counts are **operational metrics**, not quality metrics. A run with 15 hops and rich output is better than a run with 2 hops and an empty graph. The real user cares about:

1. **Correctness** — did it find the right nodes with the right verdicts?
2. **Completeness** — did it cover the scope without leaving gaps?
3. **Question-Answering** — does the enrich_view actually answer the user's question?
4. **Type-Appropriate Detail** — does the output contain the kind of detail the question requires?

## Memory-Quality Pre-Gate (THE key)

The `enrich_view` output is assembled from the engine's detail archive (`detail_slots[].analysis`, `summary`, `badge_label`, `note_caption`). **If the archive is thin, the output will be thin — no amount of `enrich_view` polish recovers it.**

Before scoring the enrich_view, audit archive depth:

| Metric | Threshold | Why it matters |
|---|---|---|
| Avg `detail_analysis` chars per noted node | ≥ 400 | Short analysis = terse notes + thin section text |
| SQL evidence citations per noted node | ≥ 1 (e.g. `INSERT ...`, `SELECT ... FROM ...`, CASE expression) | Grounds claims in actual DDL |
| Avg `summary` chars per hop | ≥ 40 | Cross-hop continuity via `working_memory.all_summaries` |
| Hops with empty `summary` | 0 | Empty summaries break the cross-hop thread |
| `badge_label` present on `relevant` verdicts | 100% | Drives the section chips in enrich_view |

If any pre-gate fails: **FLAG `memory-thin`. The enrich_view score is capped at 6/12 regardless of polish.**

## Four Scoring Dimensions (0-3 each, total 12)

### 1. Correctness (0-3)

Measures: are the right nodes in the result with the right roles?

| Score | Condition |
|-------|-----------|
| 3 | Every `Required Node` from the test spec present; verdicts align with spec; no `Forbidden Node` present unless the test inverts them |
| 2 | All required present; ≥1 verdict differs from spec but is defensible (e.g. cascade-prune of a node the spec expected to be "required") |
| 1 | 1-2 required nodes missing from result graph |
| 0 | >2 required missing, OR multiple forbidden nodes present, OR wrong-node hallucinations |

### 2. Completeness (0-3)

Measures: was the scope fully explored, and does the enrich_view have the structural scaffolding?

| Score | Condition |
|-------|-----------|
| 3 | Every scope node visited (or explicitly verdicted irrelevant); agenda drained; enrich_view has name + summary + ≥1 section + ≥N notes (N = noted-node count) |
| 2 | ≥75% of scope visited; agenda has 1-2 leftover items; enrich_view missing one of (intro, closing) but otherwise complete |
| 1 | ≥25% of scope missed; enrich_view missing sections or notes |
| 0 | Partial exploration (agent quit early); enrich_view is a stub |

### 3. Question-Answering (0-3)

Measures: does the enrich_view actually answer what the user asked?

| Score | Condition |
|-------|-----------|
| 3 | enrich_view.summary + intro directly answer the question in 1-3 sentences; sections substantiate the answer; closing reinforces it |
| 2 | Answer is present but requires reading section texts to extract |
| 1 | Partial answer; some aspects of the question ignored |
| 0 | Doesn't answer the question — generic exploration with no question-specific framing |

### 4. Type-Appropriate Detail (0-3) — BY CATEGORY

The kind of detail a good answer contains depends on the question category. Lift the `Type` field from the test's `Classification` table:

| Category | What "type-appropriate detail" looks like |
|----------|-------------------------------------------|
| `bb-` (business logic) | LaTeX math for calculations (`$CogsPerUnit = TotalCost / Qty$`), CASE-expression logic spelled out, business-rule narrative ("when customer tier is Gold, discount is 15%") |
| `ct-` (column trace) | Column rename table (`Input → Output` per hop), NULL handling, transformation rules (e.g. ISNULL, COALESCE, CAST) |
| `dep-` (dependency) | Edge types named explicitly (`exec`, `body`, `fk`), call patterns (recursive, conditional), dependency chain narrative |
| `disc-` (discovery) | Structured counts per category, schema/type tabulation |
| `perf-` (performance) | Degree counts, path lengths, hub identification, index/join hints, rough cost estimates |
| `doc-` (documentation) | Superset — formulas + column maps + dependency narrative + performance hints + examples |
| `expl-` (explanation) | SQL-level step-by-step, operator-by-operator breakdown |
| `follow-` (multi-turn) | Reference to prior-turn state in intro/closing; explicit delta (what changed between turns) |

Score:

| Score | Condition |
|-------|-----------|
| 3 | Rich, on-topic detail matching the category; uses LaTeX / tables / structured formats as appropriate |
| 2 | Detail present but generic (could apply to any category) |
| 1 | Detail thin or off-topic |
| 0 | No detail beyond node labels and section headings |

## Grading thresholds

| Total | Grade |
|-------|-------|
| 11-12 | **PASS — EXCELLENT** (use as baseline anchor) |
| 8-10 | **PASS** (acceptable, room to improve) |
| 5-7 | **PARTIAL** (re-iterate prompt / agent) |
| 0-4 | **FAIL** (architectural or prompt-level problem) |

## Mechanical auto-checks (pre-scoring, cheap)

Before applying the rubric, a script can reject runs early on:

| Check | Fail condition |
|-------|---------------|
| JSON shape | `nodes_found`, `hop_log`, `enrich_view_input.sections`, `enrich_view_input.notes` not arrays |
| Required nodes present in either `detail_slots` or `enrich_view.sections[].node_ids` or `enrich_view.notes[].node_id` | Any missing |
| Forbidden nodes absent (unless inverted by the test) | Any present as `relevant` |
| Agent never set `complete: true` — engine-driven completion only | `complete:true` seen in any hop submission |

Agent prompt guidance that supports the rubric lives in `.claude/skills/eval-loop/SKILL.md`. The skill's "BB Agent Prompt" and "CT Agent Prompt" templates enforce the memory-quality rules before results are scored.

## Terminology convention (for generated sections / badges)

The AI's choice of section labels and badges directly affects the human-readability of the output. The following convention reduces domain-specific ambiguity:

| Prefer | Over |
|--------|------|
| Upstream / Downstream | Writer / Reader |
| Sources / Targets | Producers / Consumers (in ETL contexts) |
| Inputs / Outputs | Callers / Callees (in proc contexts) |
| Core / Utility | Main / Helper |

Rationale: "writer" and "reader" invert depending on whether the focus node is a table or a view. "Upstream/Downstream" describes edge direction and is focus-agnostic.

The production system prompt (`src/ai/prompts.ts`, `src/ai/smPrompts.ts`) does NOT dictate labels — AI picks. This convention is a **suggestion** embedded in the eval-loop agent prompt, used to steer Haiku toward neutral terms. The extension's end users can override via output templates (`assets/aiOutputTemplates.yaml`).

## Terminology correction — AI behavior changes observed

After switching the suggested example labels in the agent prompt from "Writers/Readers" to "Upstream Sources/Downstream Consumers":

- `bb-q1-employee`: sections were "Writers / Hierarchy Readers / Contact Export Readers / Sales Reporting Readers" — the old bias
- `bb-inline-q3-errorlog-v2`: sections were "Error Capture / Upstream Callers" — neutral, focus-agnostic

Neutral terms also forced the AI to think about *direction* first, which produced better node grouping.

## Anti-Overfitting Discipline (MANDATORY for every prompt change)

The rubric can be gamed — tune a prompt to the wording of one test and it scores high while actually getting worse at the job. Three hard rules:

### Rule 1 — No test-specific wording in prompts

- Prompts (`prompts.ts`, `smPrompts.ts`, `package.json` modelDescription, `aiOutputTemplates.yaml`) MUST NOT contain:
  - Specific node names from any test dacpac (`spBuildSalesReport`, `FactOrders`, `CadenceWorker`, `uspLogError`, etc.)
  - Schema names from any test dacpac (`HumanResources`, `TRANSFORMATION_FINANCEHUB`, etc.)
  - Question wording from any `tests/cases/*.md` file
- Examples in prompts use `<placeholders>` or clearly fictitious names (`tableA`, `viewOrders`).
- `aiOutputTemplates.yaml` currently violates this with AdventureWorks-specific examples (`spBuildSalesReport`, `FactOrders`). **Known technical debt** — leave as-is for this sprint since changing it is a separate `/prompt-change` iteration. Document the leak so it's on the radar.

### Rule 2 — Multi-category validation before accepting a prompt change

A change must be validated across **at least 3 of these 6 test categories** before committing to the prompt:

| Category | Representative test |
|----------|---------------------|
| `bb-` (business) | bb-q1-employee, bb-q4-sales |
| `ct-` (column trace) | ct-q1-totalrevenue |
| `dep-` (dependency) | dep-q1-vemployee |
| `disc-` (discovery) | disc-q1-schemas |
| `perf-` (performance) | perf-q1-hubs |
| `follow-` (multi-turn) | follow-q2-prune-scope |

**Accept rule:** improves the rubric score on ≥2 categories, regresses on 0. Any regression → revert.

### Rule 3 — Multi-dacpac validation before release

Current eval fixture is `AdventureWorks2025_AI.dacpac` only. Before merging a prompt change to `main`, run at minimum 1 test on a **second dacpac** (`AdventureWorks_sdk-style.dacpac`). If you have access to a customer dacpac (gitignored), run there too. A prompt that passes on one dacpac and fails on another is overfitted to the training dacpac's structure.

Documented known-good: the sprint on 2026-04-17 committed structural fixes using only AdventureWorks2025_AI. Multi-dacpac validation of prompt changes is a **gate before every `/prompt-change` commit**.

### Train / Validation Split (for prompt tuning iterations)

**Training (13 cases) — free to use during prompt iteration:**
`bb-q1-employee`, `bb-q4-sales`, `bb-inline-q1-vproduct`, `bb-inline-q2-vemployee-filtered`, `ct-q1-totalrevenue`, `ct-q2-customersegment`, `ct-inline-q2-jobtitle-filtered`, `dep-q1-vemployee`, `dep-inline-q1-vemployeedepartment`, `disc-q1-schemas`, `expl-q1-sql`, `perf-q1-hubs`, `follow-q2-prune-scope`

**Validation (8 cases) — held out; ONLY touched to confirm a change before commit:**
`bb-q10-ai-report-sources`, `bb-inline-q3-errorlog`, `ct-q3-businessentityid`, `dep-q2-vsalesperson-sliding`, `disc-q2-tables`, `doc-q1-readme`, `follow-q1-add-cross-schema`, `follow-q3-active-sm-warning`

Validation tests are **never re-run during iteration** — only at the gate before accepting the change. Any drop on the validation set = revert.

### Stop conditions for the iteration loop

- 3 consecutive iterations fail to produce an accepted change → end loop, keep current baseline
- Any validation-set regression → revert change, log failure
- Hard cap: 10 total iterations

## Open items

- [ ] Implement an automated scorer (`scorer.ts` referenced in README.md doesn't currently encode this rubric)
- [ ] Add a per-test `Content-Focus` field in the Classification table to disambiguate mixed-intent questions (e.g. bb questions that also ask for performance hints)
- [ ] Baseline: record at least 3 passing runs per test before locking the target score in `ai/eval-runs/baseline.json`
- [ ] Migrate `aiOutputTemplates.yaml` examples from AdventureWorks-specific to generic placeholders (tech debt)
- [ ] Second-dacpac fixture coverage for at least 1 representative test per category
