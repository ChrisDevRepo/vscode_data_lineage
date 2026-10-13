---
name: prompt-change
description: Make minimal AI instruction changes and verify their contracts. Use before editing prompt text, model-facing tool descriptions or AI output templates; use prompt-playground for baseline/candidate model comparisons.
---

# Prompt change workflow

1. Read the relevant [prompt/template contract](../../../docs/AI_PROMPTS.md) and locate the exact owner of the requested behavior change.
2. State the user-visible behavior to change and the evidence showing what context and tools the model received. For model behavior changes, follow the [prompt comparison workflow](../prompt-playground/SKILL.md) to preserve the unchanged baseline before editing.
3. Make the smallest wording change at the owning prompt or template. Keep examples generic and consistent with the tool schema.
4. Check template schema compatibility (`node tests/tools/assert-template-schema-version.mjs`) and `npm run test:runtime`. Do not add a unit test per wording edit. A headless comparison passes the frozen question with `--prompt` ([baseline review](../../../docs/testing/README.md#before-deployment-baseline-review)). Complete the candidate review before deployment; fixed-response tests do not establish answer quality.
5. Review the diff for accidental changes to tool contracts, output schema, sensitive data, or unrelated wording. Report the changed behavior, validation results, SQL review evidence and limitations.
