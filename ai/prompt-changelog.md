# AI Prompt Changelog

## 2026-04-07 — /document: inject pre-computed origin (iteration 3)

**Bug fixed:** Round 2 stall after `get_context` call. AI output: "Context loaded. What would you like to investigate?" Root cause: `getContext` builds catalog from all model nodes (148) → 219,606 chars → exceeds 20,000-token inline budget → `model_size: "large"` → no `objects[]` with node IDs returned. AI has no ID to pass to `start_exploration.origin` and falls back to asking the user. Active filter had only 52 nodes but full model drives the inline/on_demand decision.

**Pattern insight:** `/trace X` works because X (object name) IS the search parameter injected directly into the effectivePrompt. `/document X` broke because "X = the current schema" is a schema description, not an object name — no valid `search_objects` query could be derived.

**Surface:** `/document` slash command handler — `src/extension.ts:970-990` (code + prompt)

**Change:** Added inline origin pre-computation before effectivePrompt assignment. `_aiModel.nodes` filtered to `procedure|view|function` in active schema filter, sorted by `neighborIndex[id].in.length + out.length` descending. Highest-degree result injected as `(origin id: "X")` into effectivePrompt. Fallback (no model or no candidates) preserves `get_context` flow.

```diff
- effectivePrompt = `Document the objects in scope — emit "Discovering scope…", call get_context, then start_exploration from the most-connected result. Scope: ${request.prompt}`;
+ // Pre-compute origin — inject ID directly (same as /trace injecting object name)
+ const _docOrigin = _aiModel?.nodes.filter(n => [...].includes(n.type) && schemaFilter).sort(byDegree)[0] ?? null;
+ effectivePrompt = _docOrigin
+   ? `Document the objects in scope — emit "Discovering scope…", call start_exploration from "${_docOrigin.name}" (origin id: "${_docOrigin.id}"). Scope: ${request.prompt}`
+   : `...call get_context, then start_exploration...`;
```

**Test protocol:**
- T-DOC-1: `@lineage /document the current schema` (Production + dbo filter) → round 1: AI emits "Discovering scope…" and calls `start_exploration` directly with the pre-computed ID
- T-DOC-2: Same → BB doc loop: "Hop 1 · [name] → documented · ~N remaining"
- T-DOC-3: Same → no stall, no "What would you like to investigate?", no Tip message
- T-REG-1: `@lineage /trace SalesOrderDetail` → CT path unaffected

---

## 2026-04-07 — /document: fix discover phase — get_context-first pattern (iteration 2)

**Bug fixed:** `/document` slash command still calls 0 tools after iteration 1 fix. AI output: capabilities overview + "Tip: @lineage needs model with tool/function calling support". Root cause: effectivePrompt named `search_objects` as first step but provided no valid search term. "the current schema" is a schema name, not an object name; `validateQuery` requires min 2-char object name. AI faced ambiguity and fell back to capabilities announcement.

**Surface:** `/document` slash command effectivePrompt — `src/extension.ts:979`

**Before:**
```
Document all objects reachable from: ${request.prompt}. Use search_objects to find the highest-degree node in scope as origin, then call start_exploration — do not write documentation text directly.
```

**After:**
```
Document the objects in scope — emit "Discovering scope…", call get_context, then start_exploration from the most-connected result. Scope: ${request.prompt}
```

**Best practice:** "Positive > negative" (removed "do not write…"). `get_context` has no required parameters — AI can always call it immediately without ambiguity. Pattern matches `/trace` and `/search` (terse imperative, concrete first action). Discover-phase "Discovering scope…" status line gives user visible feedback before first tool call, consistent with hop-by-hop progress in `BB_DOC_MODE_PROMPT`.

**Schema context:** `schemaCtx` injected into `systemPrompt` (message pos 0, lines 1095–1099). `effectivePrompt` is the last message. AI has `[Production, dbo]` filter before reading the document instruction — no need to repeat schema names in effectivePrompt.

**Companion:** Updated `prompt-surface-map.md` surface 20 from `/explain` → `/document` (map was outdated since commit 79498da).

**Test protocol:**
- T-DOC-1: `@lineage /document the current schema` (Production filter) → first output: "Discovering scope…", first tool call: `get_context`
- T-DOC-2: Same → AI calls `search_objects` → `start_exploration` → BB doc loop with "Hop N · [name] → documented · ~Y remaining"
- T-DOC-3: Same → "Tip: @lineage needs model with tool/function calling" does NOT appear
- T-REG-1: `@lineage /trace SalesOrderDetail` → CT path unaffected

---

## 2026-04-07 — CT prompts: refactor into buildCtModePrompt + add shared PROGRESS

**Change type:** Structural refactor + gap fix (no net text change for column mode; 3 rules added to dependency mode).

**Changes:**

1. `src/ai/prompts.ts` — replaced `CT_MODE_PROMPT` and `CT_DEP_MODE_PROMPT` constants with `buildCtModePrompt(hasColumns: boolean)`:
   - Shared tail (revisit, sub_question, FIELD MAPPING, TABLE NODES, VERDICT ALL NEIGHBORS) written once
   - Mode head and COLUMN LINEAGE RULE branch on `hasColumns`
   - `hasColumns=true` output: **identical** to old `CT_MODE_PROMPT` (zero change)
   - `hasColumns=false` output: old `CT_DEP_MODE_PROMPT` + FIELD MAPPING + TABLE NODES + VERDICT ALL NEIGHBORS (previously missing)

2. `src/ai/prompts.ts` — moved PROGRESS instruction into `buildSystemPromptBase()` (shared by all SMs):
   - `'PROGRESS: After each hop verdict, emit ONE line: "Hop N · [node_name] → verdict · ~Y remaining".\n'`
   - Removed duplicate PROGRESS lines from `BB_MODE_PROMPT` and `BB_DOC_MODE_PROMPT`

3. `src/extension.ts` — call site updated: `buildCtModePrompt(hasColumns)` replaces ternary

**Motivation:** CT dependency mode was missing 3 operational rules that CT column mode had. All SMs now share PROGRESS from one location in the base prompt instead of each mode prompt duplicating it.

**Eval results (Haiku agents, bridge server):**

| Test | Grade | Hops | Notes |
|------|-------|------|-------|
| dep-q1-vemployee | **PASS** | 9/8 (WARN) | FIELD MAPPING + TABLE NODES + VERDICT ALL NEIGHBORS all applied correctly |
| bb-q1-employee | **PASS** | 0 (inline) | All 11 required nodes found, forbidden nodes absent, PROGRESS removal no regression |

No regressions. CT column mode output unchanged (identical to pre-refactor). CT dependency mode gains 3 operational rules and passes correctness checks.

---

## 2026-04-07 — enrich_view: correct section ordering contract

**Bug fixed:** `modelDescription` in `package.json` stated "System orders sections by data-flow depth" — this is false. `orderAndAssemble()` (`src/ai/tools.ts:815`) sorts by AI's `sections[]` array index (preserves AI's written order). The incorrect claim caused the AI to write sections in arbitrary order expecting the system to reorder by depth, producing document panels in wrong reading sequence.

**Change:**
- **File:** `package.json:718` — `lineage_enrich_view` modelDescription
- **Before:** `"System orders sections by data-flow depth and assembles ## headings with step numbers — do not write description when sections are provided."`
- **After:** `"System numbers sections in YOUR WRITTEN ORDER and assembles ## headings with step numbers — write sections in the narrative sequence you want the reader to follow. Do not write description when sections are provided."`

**Companion validation fixes** (same session, `src/ai/tools.ts`):
- `description` + `sections` co-submission now rejected with explicit error (was silently discarding `description`)
- Section minimum raised from 50 → 120 chars (enforces "3-8 sentences" intent from `aiOutputTemplates.yaml`)
- Note text minimum added: 20 chars (guards against single-word captions)
- `notes` added to hint field classifier so targeted retry hints work correctly

**Deferred (next iteration):** System prompt rule 5 in `src/extension.ts` carries the same false claim: `"System assigns step numbers and orders by data-flow."` Needs a separate iteration.

**Test protocol:**
- T1: Ask `@lineage` a lineage question with multiple node groups (e.g. `how is revenue calculated`) → verify AI writes sections in a logical pipeline order, not random; verify badge "1 X" matches "## 1 X" in document panel
- T2: Submit `enrich_view` with both `description` and `sections` present → verify validation error returned, not silent discard

---

## 2026-04-06 — B-NEW6: Dynamic schema context preamble

**Bug fixed:** AI ignored active schema filter when generating SQL or starting discovery.

**Surfaces changed:**
1. `src/extension.ts` system prompt — dynamic preamble prepended when `_aiFilter.schemas` is non-empty: "Working context: user has schema(s) [X] selected. Default all searches, SQL generation, and analysis to these schemas. If answering the question requires objects from other schemas, ask the user first." Empty string when no filter active — zero behavioral change for unfiltered sessions.
2. `package.json` `lineage_get_context.modelDescription` — removed IMPORTANT clause (was: "if filter.schemas is set, those are the user's active working schemas — default all searches, SQL generation, and analysis to those schemas unless the user explicitly names a different schema in their question"). Now: "Returns schemas, stats, active filter, saved views. If objects[] present: full dataset with DDL, columns, FKs, edges — answer directly. Otherwise: use schema names in other tools' schemas[] filters."

**Design decision:** System prompt preamble is single source of truth. Removed tool description instruction to avoid "repeated instructions" anti-pattern (proven failure per best-practices.md). Preamble is not a numbered rule — rule count stays at 5.

**Injection pattern:** Follows same per-request pattern as `_aiOutputTemplates` (lines 1084-1089) and `MAX_ROUNDS` (line 1064) — `_aiFilter` is module-level var updated on every filter change.

**Test coverage added:** `testSchemaFilterContext` in `test-internal/chat-loop.test.ts` — harness wired to pass `activeFilter` through `dispatchTool`. Tests: get_context returns filter, search-within-filter succeeds, search-outside-filter returns ai_hint.

**UAT required:** Load AdventureWorks, select `[ai]` schema, ask "write a query to get total revenue by region". AI should default to `[ai]` schema objects or ask user before crossing to Sales/dbo.

---

## 2026-04-06 — Structured sections feature: 4 prompt surfaces

**Feature:** Label-keyed sections replace monolithic description. AI provides semantic badge labels + sections[], system orders by data-flow and assembles ## headings.

**Surfaces changed:**
1. `package.json` `lineage_enrich_view.modelDescription` — explains label-section data contract, no "mandatory" language, join key enforcement
2. `assets/aiOutputTemplates.yaml` `badges.instruction` — semantic labels only, no numbers, one per logical group
3. `assets/aiOutputTemplates.yaml` `sections` — new key: label=join key, text=markdown findings, system assembles headings
4. `assets/aiOutputTemplates.yaml` `description.instruction` — demoted to fallback, prefer sections[]
5. `src/extension.ts` rule 5 in system prompt — label-section data contract, no badge numbering guidance
6. `src/extension.ts` BB prompt `badge_label` example — removed "4 INIT" style, now "Source", "ETL", "Staging"

**Paired code changes (same session):**
- `src/ai/smGuards.ts`: `bfsDepthMap()` — directed BFS from origin, returns depth per node
- `src/ai/tools.ts`: `orderAndAssemble()` — matches sections to badges by label, sorts by (depth, ai_index), assembles markdown; `sections` field on `EnrichViewInput`; section validation + autoFix
- `src/ai/blackboardState.ts`: `originNodeId` in `getResult()` return; `allNotes` sorted by BFS depth; leading numbers stripped from `badge_label`
- `src/extension.ts`: `ResultGraph.originNodeId`; BB/CT store origin; enrich_view handler calls `orderAndAssemble()`; `AiOutputTemplates` + `REQUIRED_KEYS` extended with `sections`
- `package.json`: `sections` field in `lineage_enrich_view` inputSchema
- `docs/AI_PROMPTS.md`: data contract documentation, six-field table, YAML format examples

**Test protocol:**
- T1: BB exploration on any schema → `enrich_view` should produce semantic badge labels + sections[] in tool call
- T2: CT column trace → badges ordered by data-flow, heading numbers match badge numbers on graph
- T3: Check `## N Label` headings in description overlay match step numbers on graph nodes

## 2026-04-05 — BB activation prompt (surface 23): progress + invalid_nodes guidance

**Surface:** `src/extension.ts` — `bbPrompt` const, injected once at discover→bb_active transition
**Bugs addressed:** B-BB-01 (AI re-asks invalid nodes 5+ times), B-BB-02 (no progress visible to user during 190s traversal)

**Old:**
```
EXPLORATION MODE: ... (5 steps) ...

EARLY COMPLETION: Set complete:true ...
If scope_guidance is present ...

Your working memory shows ALL summaries and ALL pending questions ...
The current_task field contains your own question from a previous hop — answer it.
```

**New (additions only — original 5 steps unchanged):**
```
PROGRESS: After each submit_findings call, before calling the next tool, emit ONE line:
"Hop N · [node_name] → verdict · ~Y nodes remaining"
This keeps the user informed while you work.

INVALID NODES: working_memory.invalid_nodes lists node IDs that were rejected (not_in_model / out_of_scope / not_in_filter).
Never ask questions about not_in_model nodes — they do not exist. For out_of_scope nodes, use get_object_detail instead.
```

**Paired code changes (same session):**
1. `blackboardState.ts` line ~423: out-of-scope prune_ids now returned in `rejected_prune_ids` with typed reason (`not_in_model` / `out_of_scope` / `not_in_filter`) instead of silent skip
2. `blackboardState.ts`: `invalidNodeIds` map added — accumulates all rejected node IDs per-session
3. `blackboardState.ts` `buildWorkingMemory()`: exposes `invalid_nodes` array in working_memory
4. `App.tsx`: `useEffect` posts `filter-changed` on every filter mutation (was never fired before)
5. `tools.ts` `filterContext`: expanded to include `active_types`, `focus_schemas`, `hide_isolated`, `visible_node_count`, `total_node_count`
6. `extension.ts` line 1266: `stream.progress()` now shows node name for `submit_findings` / `start_exploration`

**Best practice:** INVALID NODES uses positive framing ("use get_object_detail instead") not negative. PROGRESS adds a concrete format example (reduces AI guessing).

**Expected impact:**
- AI stops re-asking `not_in_model` nodes after first rejection (working_memory carries history)
- User sees "Hop N · NodeName → relevant · ~12 remaining" between tool calls
- AI understands filter context (visible 85 vs full model)

**Risks:**
- 2 new instruction blocks added to BB prompt — total is now 5 original steps + 2 new sections + early completion. At 7 directives, still within the 5-8 rule reliability range from best-practices.md.
- PROGRESS instruction may produce inconsistent formatting in the first hop (no prior tool call to emit after).

**Verdict:** PENDING — requires live BB session test (ask CadenceWorker question, verify hop-by-hop output lines and no repeated spcadencerule_ev questions)

## 2026-04-03 — search_objects modelDescription (B07 + E05)

**Surface:** `package.json:495` — search_objects modelDescription
**Bugs:** B07 (column search not discoverable), E05 (no fallback to search_ddl)

**Old:**
```
Search objects by name (substring or mode='regex' for multi-pattern). Returns IDs for BFS/detail. Use schemas[] to narrow scope. For DDL body content search, use search_ddl instead. If 0 results with schemas[]: check schema_mismatch field — object may exist in another schema.
```

**New:**
```
Search objects by name or column name (substring or mode='regex' for multi-pattern). Returns IDs for BFS/detail. Results with match='column' matched a column inside the object, not the object name. Use schemas[] to narrow scope. For DDL body content search, use search_ddl instead. If 0 results: try search_ddl for DDL body matches before telling the user nothing was found. If 0 results with schemas[]: check schema_mismatch field — object may exist in another schema.
```

**Changes:**
1. "by name" → "by name or column name" (B07)
2. Added match='column' explanation (B07)
3. Added "If 0 results: try search_ddl" fallback (E05)

**Code change paired:** `searchColumns()` wired into `searchObjects()` in `src/ai/tools.ts`
**Verdict:** PASS — C3 retest confirmed column match, C4 confirmed DDL fallback

## 2026-04-03 — run_analysis modelDescription (B02)

**Surface:** `package.json:636` — run_analysis modelDescription
**Bug:** B02 (AI can't map "find hub objects with most connections" to `type=hubs`)

**Old:**
```
Structural graph analysis. Types: hubs (high-degree), islands (isolated subgraphs), orphans (no connections), longest-path, cycles, external-refs. Returns groups of node IDs with summary.
```

**New:**
```
Graph-wide structural analysis. Use for: 'most connected objects' or 'biggest nodes' (type=hubs), 'isolated tables with no dependencies' (type=orphans), 'deepest dependency chains' or 'longest paths' (type=longest-path), 'circular dependencies' (type=cycles), 'disconnected groups' (type=islands), 'external or cross-database references' (type=external-refs). Returns ranked groups of node IDs with summary.
```

**Changes:**
1. Added natural-language trigger phrases for each analysis type
2. "Structural" → "Graph-wide structural" for clarity
3. "Returns groups" → "Returns ranked groups"

**Best practice:** modelDescription is #1 routing factor — bridge user vocabulary to tool vocabulary
**Verdict:** Pending UAT retest (T07: "find hub objects with the most connections")
