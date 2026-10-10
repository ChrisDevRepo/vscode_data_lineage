---
name: prompt-playground
description: Load when comparing prompt or instruction variants with repeatable model runs and inspecting their traces.
---

# Prompt Comparison Workflow

1. Define a small question and a factual reference from an authorized dataset. Use the public demo DACPAC for tracked examples; keep sensitive datasets and answer collections out of tracked files.
2. Freeze the model/provider, model version, reasoning effort, input data and tool availability for each comparison. Capture the exact prompt and response for every run.
3. Compare correctness and completeness against the SQL and lineage graph first. Check unsupported claims, omitted requested facts, tool use and whether the response answers the question. Treat tokens and latency as secondary efficiency measures.
4. Inspect the trace and state dump for the relevant turn before attributing a difference to prompt wording. Record provider variability separately from repeatable prompt effects.
5. Change one prompt element at a time. Re-run the same cases with the same configuration and include an unchanged prompt control.
6. Screen and promote edits through the cost ladder in [`docs/testing/README.md` § Prompt Screening Cost Ladder](../../../docs/testing/README.md#prompt-screening-cost-ladder): deterministic tests, small-model screening (the vendor's cheapest model, used only to simulate the run), stage replay on the target provider, then one full run per affected question. Only target-provider stage replay on fixture and held-out inputs promotes a change; small-model screening never counts as target-model evidence.
7. Use sanitized demo-fixture examples in tracked docs. Do not commit provider traces or generated run artifacts.
