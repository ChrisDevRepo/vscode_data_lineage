---
name: prompt-change
description: Make a minimal AI instruction change and verify its contract. Use before editing prompt text, model-facing tool descriptions, or AI output templates.
---

# Prompt change workflow

1. Read the [prompt and template contract](../../../docs/AI_PROMPTS.md) and locate the owner of the requested behavior.
2. State the user-visible behavior and the evidence of the context and tools the model received.
3. Make the smallest wording change at that owner. Keep examples generic and consistent with the tool schema.
4. Check template schema compatibility (`node tests/tools/assert-template-schema-version.mjs`) and `npm run test:runtime`.
5. When the wording can change a model answer, follow the [prompt comparison workflow](../prompt-playground/SKILL.md).
6. Review the diff for changes to tool contracts, output schema, sensitive data, or unrelated wording. Report the changed behavior, the deterministic results, and any SQL evidence from the comparison.
