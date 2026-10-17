---
name: prompt-playground
description: Compare one frozen demo question before and after a prompt or model-visible change. Use for prompt or model-behavior comparisons. Deterministic failures belong to the testing skill.
---

# Prompt comparison workflow

Follow [When a live run is worth its cost](../../../docs/testing/README.md#when-a-live-run-is-worth-its-cost) and [Before-deployment baseline review](../../../docs/testing/README.md#before-deployment-baseline-review).

1. The frozen question is the `question` field in the captured run's `metrics-manifest.json`. `tests/tools/prompt-from-run.mjs` prints it. Choose the held-out question those sections describe. Langfuse Playground is the product feature for that comparison.
2. Report the SQL evidence and any deterministic results already run. The [testing rules](../../rules/testing.md) decide whether a result becomes a test.
