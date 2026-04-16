# AI Prompt Architecture — What Goes Where

Expert-backed guidance for the three-phase agent loop: **discover → active → done**. This doc is the authoritative reference for `/prompt-change` and `/eval-loop` iterations.

## TL;DR

| Layer | Lifetime | Contents | Why here |
|-------|----------|----------|----------|
| **System prompt** | Every request, stable | Role + Rules + Goals + Output Templates | Phase-agnostic identity; enables prompt caching |
| **Navigation prompt** | Built at active-phase entry, preserved across sliding wipes | Mode rules + Memory protocol + Routing rules + Classification | Hop-specific guidance, survives sliding memory wipes |
| **Synthesis prompt** | Injected at done-phase transition | Assembly instructions + Detail archive evidence + enrich_view call format | Once-only assembly guidance; fresh after memory wipe |
| **History messages** | Built up per-hop, trimmed by sliding wipe | The ongoing conversation — tool calls + results | The actual work |

## Sources

- [LangChain agent system prompts](https://docs.langchain.com/oss/javascript/langchain/agents) — Role + Context + Instructions + Output Format pattern
- [Anthropic Context Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) — "Just-in-time" data loading, stable system prompt for caching
- [Anthropic Claude Memory Tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) — Agents store what they learn in memory, pull back on demand
- [MemGPT paper](https://arxiv.org/pdf/2310.08560) — System prompt = mechanics description + function schema; READ-ONLY, stable across session
- [Letta MemGPT concepts](https://docs.letta.com/concepts/memgpt/) — Context-window sections: System Prompt + Core Memory + A/R Stats + Chat Summary + Chat History

## The Three Phases

### Phase 1 — Discover

User asks a question. AI has classic tools (search_objects, get_context, get_object_detail, run_bfs_trace, run_analysis, search_ddl, get_ddl_batch). AI decides: can I answer from raw data, or do I need an exploration?

**What the AI needs in context:**
- Identity (who it is, what its job is)
- Available tools (from VS Code LM tool descriptions — not the prompt)
- Rules (what's allowed, what's forbidden)
- Goal (success criteria for this request type)
- Output format (so the AI knows what the final artifact looks like, even if just text)

**What the AI does NOT need:**
- Memory protocol (no SM yet)
- Mode-specific rules (no mode chosen)
- Hop capture guidance

**Placement:** everything discover-time needs is in the **system prompt**. No navigation prompt pushed yet.

### Phase 2 — Active

AI called `start_exploration`. State machine is alive. Each round: AI sees hop context (focus node, neighbors, agenda, working memory), writes detail_analysis + narrative_update + verdict + route_requests, submits.

**What the AI needs:**
- Everything from system prompt (identity, rules, output format — still applies)
- Mode rules (blackboard vs column_trace — different routing logic)
- Memory protocol (how the Blackboard + Archive work, what to put in each)
- Routing rules (grounded hypotheses required for every route_request)
- Classification rules (relevant / pass / irrelevant semantics)

**Placement:** mode-specific content in the **navigation prompt**, pushed at active-phase entry.

**CRITICAL: the navigation prompt MUST be preserved across sliding-memory wipes.** Before e933b06, the sliding wipe rebuilt messages as `systemPrompt + effectivePrompt + lastAssistant + lastResult` — the nav prompt was silently dropped after hop 1 and the AI flew blind for the rest of the exploration. This was a structural bug.

**Sliding wipe (corrected):**
```typescript
messages.length = 0;
messages.push(systemPrompt, effectivePrompt);
if (navPrompt) messages.push(navPrompt);  // ← the fix
messages.push(lastAssistant, lastResult);
```

### Phase 3 — Done (Synthesis)

Agenda empty OR AI set `complete: true`. For hop-by-hop mode, the chat loop wipes history and injects: systemPrompt + effectivePrompt + synthesisPrompt + evidence archive. AI then calls enrich_view.

**What the AI needs:**
- Everything from system prompt (including output templates — they drive enrich_view shape)
- Synthesis instruction (assemble what you've captured; don't hallucinate)
- The detail archive (full evidence, no truncation)

**Placement:** synthesis instruction in a dedicated message at done-phase entry. Templates are already in the system prompt (and survive the synthesis wipe because system prompt is re-pushed).

**Inline mode skips this phase** — AI calls enrich_view during active with all DDL in context.

## What Goes WHERE — concrete rules

### SYSTEM PROMPT (always present, stable, cacheable)

Put HERE:
- ✅ Role / identity ("You are @lineage...")
- ✅ Operating context (platform, active schema filter)
- ✅ Hard rules that apply everywhere ("NEVER fabricate IDs")
- ✅ Goals / success criteria
- ✅ Output format templates (from user-editable yaml)
- ✅ MATH conventions (LaTeX)
- ✅ Quality bar (what makes a good answer)

Do NOT put here:
- ❌ Mode-specific rules (blackboard vs column_trace) — goes in nav prompt
- ❌ Memory mechanics specific to hop-by-hop exploration — goes in nav prompt
- ❌ Evidence archive content — goes in synthesis message (once)
- ❌ Per-hop working memory — delivered by engine in each hop_context

### NAVIGATION PROMPT (active-phase only, preserved across sliding wipes)

Put HERE:
- ✅ Mode-specific role framing ("EXPERT COLUMN-TRACE ANALYST")
- ✅ NODE CLASSIFICATION rules (relevant / pass / irrelevant semantics)
- ✅ YOUR WORKFLOW (ANALYZE → SYNTHESIZE → ARCHIVE → ROUTE)
- ✅ MEMORY TIERING PROTOCOL (Blackboard / Archive / Map — with reference to system-prompt templates for what to capture)
- ✅ GROUNDED ROUTING rules (selection-inference)
- ✅ GROUNDING CONTRACT (anti-hallucination at hop time)

Do NOT put here:
- ❌ Output templates (duplicates system prompt)
- ❌ User question re-statement (engine's `current_question` field carries it)
- ❌ Detailed tool descriptions (VS Code LM API handles that)

### SYNTHESIS PROMPT (done-phase only, injected once)

Put HERE:
- ✅ "You've finished exploring; assemble now" signal
- ✅ Reminder: use ONLY archive evidence, don't hallucinate
- ✅ Brief reminder of the user's original question
- ✅ Instruction to call enrich_view with specific structure

Do NOT put here:
- ❌ The templates themselves (system prompt has them; referencing is enough)
- ❌ Mode-specific rules (exploration is done)

### HOP CONTEXT (per-hop, engine-generated, not a prompt)

Delivered in the submit_findings tool response:
- ✅ focus_node (ID, name, DDL, columns)
- ✅ neighbors (with metadata)
- ✅ working_memory (blackboard state, agenda, visited nodes, navigation path)
- ✅ current_question (the hop's specific sub-goal)

This is engine-owned. Prompt changes don't affect it; engine changes do.

## Sliding memory — what survives, what doesn't

```
BEFORE wipe (end of hop N):
  [systemPrompt, effectivePrompt, ...history, navPrompt, hop1Assistant, hop1Result, ..., hopN_Assistant, hopN_Result]

AFTER wipe:
  [systemPrompt, effectivePrompt, navPrompt, hopN_Assistant, hopN_Result]
```

**Rationale:** the AI retains full stable identity + the most recent engine response, but doesn't drag the entire per-hop history forward. Each hop effectively runs with a clean context plus one-step memory.

**Preserved on error:** if any submit_findings in the round errored, the sliding wipe is SKIPPED so the AI can see the error and self-correct (fix from 8ec63df + c332a7b).

## Anti-patterns to avoid (learned from this sprint)

1. **Putting output templates in the nav prompt AND system prompt** — duplication. The nav prompt's memory protocol should REFERENCE the system prompt's templates, not copy them.
2. **Extracting output templates to a separate active-phase message** — also duplication once system prompt has them.
3. **Forgetting to preserve navigation prompt across sliding wipes** — the AI loses mode guidance after hop 1. Symptoms: AI stops following the classification rules, loses track of routing requirements, gives up early.
4. **Mixing synthesis and active concerns in one prompt** — keep active (hop-by-hop) concerns in nav prompt; put "you're done, assemble now" in synthesis prompt.

## When to change what

| Symptom | Likely prompt fix | Surface |
|---------|------------------|---------|
| AI misses required formulas / rename tables in output | Update aiOutputTemplates.yaml section instruction | `assets/aiOutputTemplates.yaml` |
| AI routes to wrong neighbors | Update GROUNDED ROUTING block | `src/ai/smPrompts.ts` BLOCK.routingRules |
| AI over/under-prunes | Update NODE CLASSIFICATION block | `src/ai/smPrompts.ts` BLOCK.classification |
| AI's narrative rambles or restates | Update memory protocol for Blackboard | `src/ai/smPrompts.ts` BLOCK.memoryProtocol |
| AI hallucinates node IDs | Update hard rules | `src/ai/prompts.ts` `buildSystemPromptBase` |
| AI uses wrong tool for metadata questions | Update rule 3 routing guidance | `src/ai/prompts.ts` `buildSystemPromptBase` |
| Discovery answers lack schema breakdown | Update get_context tool description | `package.json` modelDescription |

Use the `/prompt-change` skill — it enforces one surface per iteration and logs every change so rollback is clean.
