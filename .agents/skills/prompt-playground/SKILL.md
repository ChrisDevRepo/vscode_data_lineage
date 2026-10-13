---
name: prompt-playground
description: Compare unchanged baseline and candidate model answers manually against SQL and lineage evidence before deployment. Use for prompt or model-behavior comparisons; deterministic test failures alone belong to testing.
---

# Prompt comparison workflow

1. Select affected questions and a held-out example from an authorized dataset; use the public demo DACPAC for tracked examples. Keep sensitive data and answer collections out of tracked files.
2. Before editing, run and preserve the unchanged baseline using [baseline review](../../../docs/testing/README.md#before-deployment-baseline-review). Freeze provider/model, reasoning effort, input data, question, scope and tool availability. Pass the frozen question as `npm run test:ai:headless -- --prompt "QUESTION"`. Capture the exact request and response with `--trace-verbose`.
3. Change one prompt element at its owner, run the deterministic checks, then run the candidate with the same `--prompt`, data, and configuration.
4. Before deployment, inspect baseline and candidate answers against SQL and the lineage graph with `trace-metrics.mjs` and `case-scorecard.mjs` as described in [Before-deployment baseline review](../../../docs/testing/README.md#before-deployment-baseline-review). Check requested facts, formulas, row rules, scope, output instructions and unsupported claims. Inspect the relevant request id and trace before attributing differences to wording; record the SQL evidence for accepting changes. Tokens and latency are secondary. Neither transport success nor metrics establishes content quality.
5. Use sanitized demo examples in tracked docs. Keep provider traces and generated evidence local. Report baseline/candidate differences with SQL evidence, validation results and limitations. A baseline or candidate difference is recorded against SQL. It is not encoded as a new Vitest, Playwright, Electron, or catalog row.
