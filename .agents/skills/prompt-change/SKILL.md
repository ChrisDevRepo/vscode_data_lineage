---
name: prompt-change
description: Load before editing AI prompt text, tool descriptions, or AI output templates, or when correcting an instruction that changes model behavior.
---

# Prompt Change Workflow

1. Read `docs/AI_PROMPTS.md` and locate the exact prompt/template owner before editing.
2. State the user-visible behavior to change and the evidence showing what context and tools the model received.
3. Make the smallest wording change at the owning prompt or template. Keep examples generic and consistent with the tool schema.
4. Check deterministic prompt/template tests and schema compatibility checks (`node tests/tools/assert-template-schema-version.mjs`). For model behavior, use `.agents/skills/prompt-playground/SKILL.md`; do not treat fixed-response tests as model evidence.
5. Review the diff for accidental changes to tool contracts, output schema, sensitive data, or unrelated wording. Describe what behavior was checked and any limitation.
