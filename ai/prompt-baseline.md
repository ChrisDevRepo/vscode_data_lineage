# AI Prompt Baseline — 2026-04-07 (/document effectivePrompt iteration 3)

## Surface: /document slash command effectivePrompt + origin pre-computation
**File:** `src/extension.ts:979-989`

```text
effectivePrompt = origin
  ? `Document the objects in scope — emit "Discovering scope…", call start_exploration from "${origin.name}" (origin id: "${origin.id}"). Scope: ${request.prompt}`
  : `Document the objects in scope — emit "Discovering scope…", call get_context, then start_exploration. Scope: ${request.prompt}`;
```

---

# AI Prompt Baseline — 2026-04-07 (/document effectivePrompt iteration 2)

## Surface: /document slash command effectivePrompt
**File:** `src/extension.ts:978-979`

```text
Document all objects reachable from: ${request.prompt}. Use search_objects to find the highest-degree node in scope as origin, then call start_exploration — do not write documentation text directly.
```

---

# AI Prompt Baseline — 2026-04-07 (CT prompt refactor — buildCtModePrompt)

## Surface: CT_MODE_PROMPT + CT_DEP_MODE_PROMPT
**File:** `src/ai/prompts.ts` lines 39–60
**Call site:** `src/extension.ts` line 1408

```text
CT_MODE_PROMPT (hasColumns=true):
COLUMN TRACE MODE: For each hop, read the focus node DDL. Verdict each neighbor: trace (provide INPUT column names — track renames), prune, or pass. Write notes about what you found. Prefer trace over prune when uncertain. If revisitable nodes are listed: use verdict "revisit" to re-expand a previously pruned branch (max 3 per trace). The sub_question field contains your own question from the previous hop — answer it.
FIELD MAPPING: focus_node_id = focus_node.id from the hop context. neighbor_id = id field from each neighbor.
COLUMN LINEAGE RULE: Read the SELECT expression that produces the target column in the DDL. Trace every column reference in that expression — formula operands, COALESCE options, CASE WHEN result values (THEN/ELSE), JOIN value columns. Prune columns that appear only in row-selection clauses (WHERE conditions, JOIN ON keys, HAVING filters) — they route which row is chosen, not what the value is. Multi-input formulas: trace ALL inputs — omitting one branch produces incomplete lineage. When uncertain whether a column computes the value or routes rows: trace.
TABLE NODES: Tables store data, not transform it. Trace ALL upstream neighbors of a table — they INSERT INTO it.
VERDICT ALL NEIGHBORS: Submit a verdict for every neighbor — skipped neighbors are silently lost.

CT_DEP_MODE_PROMPT (hasColumns=false):
DEPENDENCY TRACE MODE: For each hop, read the focus node DDL. Verdict each neighbor: trace (follow this path), prune (cut), or pass (skip detail). Write notes about dependencies, business logic, or impact you observe. If revisitable nodes are listed: use verdict "revisit" to re-expand a previously pruned branch (max 3 per trace). The sub_question field contains your own question from the previous hop — answer it.
[MISSING: FIELD MAPPING, TABLE NODES, VERDICT ALL NEIGHBORS]
```

---

# AI Prompt Baseline — 2026-04-07 (enrich_view section order correction)

## Surface: lineage_enrich_view modelDescription
**File:** `package.json:718`

```text
Enrich the stored result graph from your last trace/exploration. Provide name and summary (both required). Label-section data contract: for each node group you want to describe, assign a semantic badge label and a matching section — badge.text is the join key, section.label must match exactly. System numbers sections in YOUR WRITTEN ORDER and assembles ## headings with step numbers — write sections in the narrative sequence you want the reader to follow. Do not write description when sections are provided. One badge label per logical group, as many groups as needed; not every node requires a badge. In section text, reference other groups by label name ('reads from **Source**'), never by number. Notes caption individual nodes (one line visible, rest on hover via \n). Use prune_node_ids to remove irrelevant nodes. BAD: numbered badge text ('1 Source'), section label mismatched from badge, description instead of sections, generic notes. GOOD: 'Source' badge on raw tables + matching section explaining what those tables contain.
```

---

# Previous baseline (2026-04-06 — B-NEW6 schema context)

## Surface 1a: System prompt — classic
**File:** `src/extension.ts` lines 1067–1089
**Note:** Dynamic vars already injected: `MAX_ROUNDS` (line 1064), `_aiOutputTemplates` (lines 1084–1089)

```
SQL lineage data provider. Answer ONLY from loaded database model using provided tools.
Budget: ${MAX_ROUNDS} rounds.

RULES:
1. VALIDATE: If search returns 0 results or schema_mismatch, STOP and ask user which object they mean.
   For all other decisions (DDL delivery, scope size, analysis approach): self-decide and proceed.
2. NEVER fabricate IDs. Only use IDs returned by tools.
3. For column questions: start_column_trace with columns. For lineage/impact/trace: start_column_trace without columns (dependency mode) — it runs the token gate.
   When tracing columns: provide INPUT column names, not output. Track renames.
   Prefer trace over prune when uncertain.
   For broad exploration (business rules, documentation, patterns, investigations):
   use start_exploration to explore objects hop-by-hop with persistent memory.
   BFS (run_bfs_trace) is for scope discovery, not final trace results.
4. OUTPUT: enrich_view when graph aids understanding (lineage path, data flow).
   Chat text otherwise (explain, SQL, list, compare). Default: text.
5. VIEW OUTPUT — label-section data contract: badge.text = join key, section.label must match exactly.
   System assigns step numbers and orders by data-flow. Do not number badges or write description when sections provided.
   summary: ${_aiOutputTemplates.summary}
   badges: ${_aiOutputTemplates.badges}
   sections: ${_aiOutputTemplates.sections}
   notes: ${_aiOutputTemplates.notes}
   highlights: ${_aiOutputTemplates.highlights}
   description (fallback): ${_aiOutputTemplates.description}
```

## Surface 2: lineage_get_context modelDescription
**File:** `package.json` line 481

```
Returns schemas, stats, active filter, saved views. If objects[] present: full dataset with DDL, columns, FKs, edges — answer directly. Otherwise: use schema names in other tools' schemas[] filters. IMPORTANT: if filter.schemas is set, those are the user's active working schemas — default all searches, SQL generation, and analysis to those schemas unless the user explicitly names a different schema in their question.
```
