---
name: trace-analysis
description: Evaluates recorded AI runs against SQL ground truth. Compares a branch with a baseline, finds regressions, grades answer correctness and completeness, counts errors, rejections and gates, and judges self-repair. Use when asked to compare runs, check for regression, grade answers, or analyze NDJSON, state dumps, debug logs and trace-backend data from recorded runs. For one failing turn use trace-debug; for prompt-variant experiments use prompt-playground.
---

# Trace Analysis

Evaluates recorded runs from their artifacts. Correctness against the SQL decides the verdict; counts, tokens and latency are secondary.

## Rules that always hold

1. Fix the configuration first (section 1). A changed variable is a different experiment.
2. Collect every evidence source (section 2). Record a missing source as missing; never infer it.
3. Judge answers against ground truth derived from the SQL, not from another model's answer.
4. Classify errors by source before reading any answer.
5. Zero rejections means the repair loop was not exercised, not that it works.
6. A claim wrong in both baseline and candidate is a shared defect, not a regression.
7. State what is vendor guidance and what is this repository's own method. Thresholds are declared before running, never tuned after.
8. Every model run costs money. Run each question once per arm. Never repeat an unchanged run to average a metric. Re-run only to confirm a specific suspected regression (section 5).
9. Technical defects come first. Run `node tests/tools/trace-metrics.mjs --fail-on-defect` over the runs before reading any answer. A defect is a fault of the pipeline with a stated correct behavior; it blocks a push until its root cause is fixed in the owning layer. Everything else is a signal: an answer may be incomplete or wrong, and the signal is verified by reasoning on the question, the served instructions and the SQL before it is called a fault. Counts of correct, wrong and absent facts are evidence for that reasoning, not a score and not a verdict.
10. The repository is public; run artifacts are not. Traces, state dumps, debug logs, hop logs, answers, audit reports and provider output stay in ignored local directories or the access-controlled trace backend, never in a commit, issue or pull request. Redact credentials, database identifiers and customer content before sharing anywhere. Commit conclusions and fixes, not evidence.

## Terms

- **run**: one answered request, from the user message to the final answer or stop.
- **hop**: one round of tool calls by the exploring agent.
- **gate**: a consent prompt. It is not a fault.
- **rejection**: a tool call refused with a code. It is an expected control outcome, not a provider error.
- **arm**: one set of runs under one configuration (baseline or candidate).
- **trace source**: the local event trace or the trace backend. Say which.

## Checklist

Copy and tick:

- [ ] Technical defects checked first (`trace-metrics --fail-on-defect`); each with root cause or open status
- [ ] Configuration and baseline recorded
- [ ] Per run: outcome, errors, calls, duration, tokens
- [ ] Errors classified by source
- [ ] Rejections counted by tool and code; gates counted separately
- [ ] Self-repair exercised with negative cases
- [ ] Ground truth derived from the SQL
- [ ] Answers graded; fact ledger built
- [ ] Defect entry layer located
- [ ] Baseline compared; decision rule applied
- [ ] No repeat runs beyond a targeted confirmation
- [ ] Run identity (session, tags, label) and evidence stored centrally
- [ ] Efficiency reported last

## 1. Fix the experiment

- One model, provider, reasoning effort, dataset, question set and tool configuration per comparison. Record them with the commit, dataset hash and prompt hash.
- Name the baseline: a commit or earlier run set made under the same configuration. Without one, report findings, not regressions.
- Use the same concurrency for both arms. Provider latency varies with load, so never compare latency across different load.
- Start each run from a clean state (no carried-over memory, cache or session). Leftover state correlates failures.
- Run each question once per arm. Reuse the baseline runs already recorded; do not re-run an unchanged baseline or candidate to obtain means. A single run shows an outcome, not a rate, so state that in the report and decide from the claim-level evidence, not from metric averages.
- Declare the regression thresholds before running.
- Keep failed runs in the data.

## 2. Collect every evidence source

Keep all five for each run; each answers what the others cannot.

| Source | Gives | Cannot give |
|---|---|---|
| Local event trace (NDJSON) | Ordered events per request: phases, model calls with usage and latency, tool calls with `status` (`accepted`, `rejected`, `gate`, `refused`, `not_evaluated`, `dispatch_error`; only `rejected` is charged), rejection code and field paths. | Prompts and payloads unless the opening record says verbose capture was on. |
| State dump | Final navigation state: scope, visited and pruned nodes, agenda, memory. | The transcript or event order. |
| Debug log | Runtime decisions: attempt outcomes, rejection and gate lines with reason and hint, retries, stop reasons. | Model input and output. |
| Hop log and result files | Tool inputs and outputs per hop; the final structured result and answer text. | Timing. |
| Trace backend (optional) | Parent/child spans, provider-side latency, usage, model input/output, error status. Useful for baselines recorded before local capture existed. | Whatever was not exported. A count absent from the backend is unknown, not zero. State what the backend omits (non-model spans, tool status, unsampled traces, filtered spans) before trusting its totals. |

Align sources by request id. Content capture (prompts, tool arguments and results) is sensitive: keep it off by default and redact before sharing. Keep a central copy of the evidence in the access-controlled trace backend, correlated by request id and run folder name, so the local files can be deleted.

Fields to record per model call: operation, provider, requested and responded model, finish reason, error class if it failed, and token counts as separate non-overlapping fields (input, output, reasoning, cache read, cache write), stating whether input includes cached tokens and output includes reasoning tokens. Per tool call: tool name, call id, outcome, error class. Record a session or conversation id only when a real one exists. Record each model generation attempt separately; stage-replay samples also report their transport attempt count.

## 3. Reference dataset and cases

- Dataset: AdventureWorksAI, the public demo DACPAC (`tests/fixtures/AdventureWorks2025_AI.dacpac`), schema `ai`, or another authorized dataset. It contains deliberate traps. SQL comments are part of the ground truth: filter-only joins, commented-out code, a TODO naming a table that does not exist, defaults via `COALESCE`, dedup that silently drops rows, a column never populated, writes of one name that read as another.
- The traps are public and the question set is fixed, so runs can overfit or saturate. Keep a held-out variant (renamed objects, new traps) and retire a question that every arm passes in every run: it no longer discriminates.
- Derive the ground truth yourself from the object bodies. Do not use a model answer as reference. For quick lookups of what the product itself reports about the dataset (what an object reads and is read by, which objects mention a name, scope sizes, graph patterns), use the facts toolbelt over the live MCP server (`node tests/tools/mcp/facts.mjs`, see docs/EDH_TESTING.md) instead of writing a one-off extractor; the SQL remains the reference for the verdict.
- Question shapes (labels for this skill, not repository identifiers); adapt names to the dataset:

| Label | Shape | Exercises |
|---|---|---|
| Q-list | List objects in a schema | Discovery only |
| Q-text | Which definitions mention a name | Text search |
| Q-near | Immediate neighbours of an object | Bounded graph read |
| Q-both | Upstream sources and direct consumers of a procedure | Both directions |
| Q-object | Object trace upstream with business logic of every source | Full-scope exploration, many hops |
| Q-column | Column trace to original sources | Column chain, filter-only influences, defaults |
| Q-column-consumers | Column trace plus consumers | Origins and consumers together |
| Q-depth | Same with a depth limit | Scope discipline |
| Q-negative | Nonexistent object, bogus column, request to execute SQL, ambiguous name | Rejection and refusal paths, self-repair |

- Multi-hop questions take minutes. Set the run deadline above the slowest healthy run, or healthy runs look like failures.

## 4. Analysis procedure

0. **Technical defects.** Run the trace metrics (rule 9) and stop at any defect: find its root cause in the owning layer before judging a single answer. Then take each signal and verify it by reasoning (the finding states what to check).
1. **Outcome.** Per run: runtime outcome, export outcome, errors, model calls, duration, tokens by phase.
2. **Classify every error by source before reading the answer.** Provider or network, timeout or deadline, cancellation, truncation or output-limit stop, runtime or tool fault, policy rejection, missing context, grader error, answer quality. Rejections are control outcomes and are excluded from the provider error rate. If subagents are available, give one reviewer per distinct error class (same message, same cause) the run artifacts and ask for timeline, cause, the code path that handled it, and an environmental-or-defect verdict; otherwise do this yourself, one class at a time. Do not average errors away.
3. **Rejections.** Count by tool and code from the local trace. For each: what the model was told, whether the message named the field and the allowed action, how many further calls the repair took, whether the same field was rejected again.
4. **Exercise self-repair deliberately** with the negative cases. Check that the model recovers or stops cleanly and that the stop is bounded.
5. **Grade correctness and completeness against the SQL.** Build the ground truth: origins, consumers, filters, defaults, grain, executed versus commented code. Grade with deterministic checks first (expected objects, joins and defaults matched against a claim checklist derived from the SQL). Use model graders only for the residual claims, with a rubric, one grader per dimension, an "unknown" option, and a grader other than the one that produced the answer. Calibrate against a sample reviewed by a person and record the agreement. If subagents are available, use one independent reviewer per answer, given the derived ground truth; otherwise review each answer separately. Judge the answer against the question and the served instructions as well as the SQL: requested depth and direction (with a one-line pointer to deeper origins), requested answer form, user exclusions (an excluded object does not appear) and the output contract. A fact-correct answer that ignores the request fails that check.
6. **Locate where a defect enters.** Check the hop findings and state memory for the fact. Present in the hop but absent in the answer: dropped at synthesis. Wrong in the hop and copied: a hop error propagated. Absent from the hop: never captured. Each points at a different layer.
7. **Compare with the baseline** using section 5. If a baseline claim cannot be confirmed against the SQL, return to step 5; do not classify it.
8. **Efficiency last.** Model calls, input tokens per call and per phase, rejection rounds, latency. Report p50 and p95 per call and per phase, and wall time separately from the sum of model time. Totals mislead when answers become more detailed.

## 5. Regression comparison

This method is the repository's own; the severity scale, the fact ledger and the decision rule are not vendor-defined. Run regression evaluations when the change affects AI behavior.

**Pairing.** Pair by question, one baseline run against one candidate run. Correctness is judged per fact against the SQL, which needs no averaging. A metric difference between two single runs is indicative only; do not call it real from one pair.

**Fact ledger.** Per question, list from the SQL the facts a correct answer needs and the traps it must avoid: each origin and consumer on the requested path, each filter, default and join role, each dedup or drop that changes the row set, each executed-versus-commented distinction, each out-of-scope object, and each instruction the question states (depth, answer form, exclusion). Score every fact in every run as `correct`, `wrong`, `absent` or `not applicable`.

| Baseline | Candidate | Class |
|---|---|---|
| correct | wrong or absent | regression |
| wrong or absent | correct | improvement |
| wrong or absent | wrong or absent | shared defect |
| correct | correct | unchanged |

An object left out is an omission only if the SQL puts it on the requested path; confirm that first. A fact the served instructions tell the model to leave out (an absent mechanism, noise, a hazard that depends on data the dataset does not hold, an override combination the instructions do not ask for) earns credit when stated and is `not applicable` when omitted. A trap fact is `wrong` only when the answer makes the trap claim. Score each fact once: a consequence restated under a second fact, or an extra claim repeating a fact already scored `wrong`, is not counted again. An answer that states a fact and contradicts it elsewhere scores `wrong`.

**Severity.**
- P0: wrong claim on the requested lineage path, or a hallucinated object, column or edge.
- P1: omission of a requested origin, consumer or step, or an answer outside the requested scope or depth.
- P2: wrong or missing secondary detail (defaults, side effects, error handling, grain notes).
- P3: noise, repetition, placeholder text.

An `absent` fact is at most P1, whatever severity the ledger gives its wrong form. Instruction violations (step 5 of section 4) carry a severity and count in the totals with the ledger facts. Blind graders see the question, ledger, SQL, served output contract and answer, never the run label or arm mapping.

**Process metrics.** Compare the candidate run with the baseline run, and treat differences in latency, tokens and call counts as indicative because one run carries provider and sampling noise: errors (any new non-environmental error class), rejections (new codes, more per run, more repair rounds per rejected call, the same field rejected twice), gates (count per request, and where they fire), stop reasons (any new reason, or a stop at an earlier hop), then calls per question and tokens and latency per call.

**Column-trace checks.** A column trace is judged on what each hop sent and what the report states, not only on the final facts. Apply these to every CT comparison; each needs a ledger fact, a process metric or a grader rule, never a keyword match.
- *Rejections and repair.* The metrics give the rejections by tool and code, the replies each repair took (first, second, third or later retry, or never), whether a field was rejected twice, and for every resend its tokens and fields against the rejected reply. A repair after the first retry, an unresolved repair and a resend that carries more than the defect are findings, whatever the answer quality. Compare arms on the same measure.
- *Run-to-run spread.* Run `node tests/tools/trace-metrics.mjs` over the repeated runs of one question (its defects and signals, rule table in `docs/testing/README.md`, cover the mechanical checks below; `--fail-on-defect` makes the defects scriptable). Compare value inputs, row roles and active columns across equivalent runs. The metrics classify differing source and row-role sets as defects; differing snippet citations are signals to check against the deciding SQL, not defects by themselves.
- *Value-deciding predicate columns.* A column tested in a `CASE` branch of the traced value, inside a conditional aggregate, or in the `WHERE` of a count with no value argument decides the value. The ledger holds one fact per such column, as a value input. A column that is classed as a row filter, dropped, or whose supplier object is pruned is a wrong fact. A `WHERE` or `ON` that only removes rows stays a filter.
- *Row roles.* Window partition and order keys and grouping keys change the values of neighbouring rows. The ledger holds a fact for that effect (adding or removing one row changes every other row's share, number or residual in its group), and the report must state it. The `rowRole` list of the metrics shows what the hop sent.
- *Prose against its own SQL.* Read every condition, order, guarantee, default and interpretation in a hop section or the report against the SQL quoted beside it. A statement the SQL contradicts is wrong even when no ledger fact covers it; a reading the SQL does not show belongs under Gaps; the snippet wins over the prose.
- *Unsupported statements.* Intro and closing sentences that state a count, a guarantee, a business use, the absence of a mechanism, or downstream use for an upstream-only scope need a captured slot behind them. An unsupported sentence is an extra claim (P2 or P3) whether or not it is provably false.
- *Operand completeness.* For a derivation through five or more renames the ledger lists every operand as its own fact. A missing operand is absent; an operand present in some runs only is spread.
- *Prune against sources.* The `conflicts` list of the metrics must be empty: a node pruned in the same call that names its columns as sources is lost from the trace. Check that such a node is not missing from the report.
- *Follow-up questions.* A question that presupposes its answer ("confirm X has no further derivation") is a P3 finding; read the `questions` of the submissions.
- *Lost work.* A run ended by a transport error is recorded with the hop it reached and the time discarded; one connection-level retry is expected.
- *Fixture limits.* The public fixture and its held-out twin hold none of the conditional-aggregate, count-`WHERE`, window-share or long-chain patterns. State that limit in the report and use a synthetic model for them; a pass on the public fixture says nothing about those patterns.

**Decision rule** (declare thresholds before running):
- Block: a P0 or P1 regression, a new non-environmental error class, or any defect reported by `tests/tools/trace-metrics.mjs` (a rejected call never resent, a run that did not finish, a field rejected twice, a prune of a named source, a differing source set between repeated runs). These are technical defects: find the root cause, fix it in the owning layer without a workaround, or record the defect as open and do not push.
- Investigate before merge: a P2 regression, a new rejection code, a stop at an earlier hop.
- Report only: efficiency differences, shared defects.
- Environmental failures (account state, connect timeouts, rate limits) are neither pass nor regression. Record them separately and re-run once after the cause clears.

**Attribute to the change.**
1. List the commits in the change set and the behavior each intends to change.
2. For each regression, name the commit whose change could cause it and check the layer where it enters (section 4, step 6).
3. Confirm only the suspected regression, and only when the cause is not already clear from the artifacts: re-run that one question at the candidate and at the commit before it, same configuration. If two commits are plausible, bisect. This is the only reason to repeat a run.
4. A regression with no plausible commit is variance or a confounder until a targeted re-run reproduces it.

**Confounders to rule out first.** Different load or concurrency, different provider state, different configuration, a baseline recorded with fewer captured fields, non-determinism, a fact that depends on missing schema definitions, and a grader error. State which were ruled out. A baseline comparison is a review aid, not a release gate by itself.

## 6. Interpretation rules

- Do not judge quality from length, table rows, code fences or token counts. More output can mean more detail or more noise.
- Counting object names by pattern is biased by formatting (links versus bracketed names). Match plain names against the dataset's own object list.
- Process counts are diagnostic. Pass or fail rests on the outcome, since valid paths vary.
- Reviewer agreement is evidence, not proof. Mark claims that depend on engine semantics or missing definitions as low confidence.
- A passing run with no rejections says nothing about rejection handling.
- Report unrunnable checks with the missing prerequisite.

## 7. Using the trace backend effectively

The repository's optional exporter is `tests/harness/langfuseExport.ts`, invoked
by `npm run test:ai:headless -- --langfuse`. It uses OTLP/HTTP JSON and the
configured `LANGFUSE_*` settings; the public extension does not export traces.

- Set `--label`, `--session` and `--tag` before export to identify the question,
  arm and commit. Keep the local run folder correlated with those identifiers.
- Each tool call is a `tool` observation: rejections use `WARNING`, thrown
  handlers use `ERROR`. Trace metadata records tool outcomes and rejection codes.
  `result_too_large` remains an accepted tool record; inspect its result/debug log.
- `--attach` uploads local evidence through the media API and references it in
  trace metadata. Literal keys are redacted; database content can remain. Use
  only an authorized private backend and public or synthetic input.
- Keep the SQL fact ledger as the verdict. Backend counts and scores support
  review; they do not establish answer correctness.
- Verify the deployed backend's current API, filtering, retention and deletion
  behavior before relying on it. This repository does not implement backend
  administration or certify UI behavior. Do not re-export or delete evidence
  merely to relabel it; preserve the original run and record the mapping locally.

## 8. Report

Short, structured, evidence first, technical defects before everything else:

0. Technical defects found by the trace metrics, each with its root cause, the layer that owns it, and the fix or its open status. None found is stated.
1. Configuration, baseline, thresholds, and that each arm is a single run.
2. Per-question table: outcome, calls, rejections by code, gates, errors, duration.
3. Backend errors by class with cause and verdict.
4. Correctness and completeness per answer: the signals and ledger gaps that were verified by reasoning on the question and the SQL, the confirmed errors with quotes and severity, and the ones that did not hold up.
5. Where defects enter (hop, synthesis, runtime), the commit each regression is attributed to, and the confounders ruled out.
6. Self-repair findings.
7. Defects and open questions, each with file and line or artifact path, and a confidence level.
