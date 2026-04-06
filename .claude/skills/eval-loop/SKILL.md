---
name: eval-loop
description: Run the AI evaluation loop — test SM + AI correctness via bridge server with Haiku agents, score results against baselines, analyze regressions, recommend fixes. Use when user says "eval", "run eval", "test AI quality", "check SM correctness", or "eval-loop".
disable-model-invocation: true
argument-hint: "[test-id | 'all']"
---

# AI Evaluation Loop

Self-learning evaluation cycle for the @lineage AI chat participant. Tests whether the state machine (SM) + AI agent produce correct lineage graphs by running Haiku agents against the HTTP bridge server, scoring results against known baselines, and recommending improvements.

**Primary metric: CORRECTNESS** — right nodes, right edges, right chains, right prunes. Token usage is logged but not scored.

## Prerequisites

- Bridge server running: `npx tsx test-internal/ai-test-server.ts [dacpac]`
- Test definitions in `${CLAUDE_SKILL_DIR}/eval-suite.yaml`
- Baselines (if any) in `tmp/eval-runs/baseline.json`

---

## Phase 0: Pre-Flight

1. Check bridge server: `curl -s http://127.0.0.1:3271/health`
   - If down → tell user which command to run (with correct dacpac for requested test)
   - If up → note dacpac loaded, node/edge count
2. Read test suite from `${CLAUDE_SKILL_DIR}/eval-suite.yaml`
3. Filter to `$ARGUMENTS` if provided (test ID or "all"). Default: all.
4. Group tests by dacpac — if multiple dacpacs needed, process one group at a time (user restarts bridge between groups)
5. Create run directory: `tmp/eval-runs/run-{YYYY-MM-DDTHH-MM}/`

---

## Phase 1: Run Tests

For each test case:

1. **Set filter** — if test has `filter.schemas`, POST to `/filter`:
   ```
   curl -s -X POST http://127.0.0.1:3271/filter -d '{"schemas": [...]}'
   ```

2. **Create session** — POST to `/session`, capture sessionId

3. **Run per-hop Haiku agent** — spawn Agent(model: "haiku") with this prompt pattern:

   For BB tests:
   ```
   You are testing an AI lineage tool. Bridge server at http://127.0.0.1:3271.
   Session: {sessionId}.

   SYSTEM PROMPT (from GET /prompts → system):
   {system_prompt}

   MODE PROMPT (from GET /prompts → bb_mode):
   {bb_mode_prompt}

   QUESTION: {test.question}

   INSTRUCTIONS:
   - Call tools via POST http://127.0.0.1:3271/tool with body {"tool": "lineage_...", "input": {...}, "sessionId": "{sessionId}"}
   - Start: search for origin, then call lineage_start_exploration
   - If SM mode: submit_findings hop by hop until agenda empty or complete:true accepted
   - If inline: analyze the BFS result
   - After completion: report your final result as JSON with these fields:
     nodes_found: [list of node names in result]
     delivery: "inline" or "sm"
     hops: number of submit_findings calls
     badges: [list of badge labels if any]
     prune_decisions: [list of pruned node names]
     text_response: your final analysis text
   ```

   For CT tests:
   ```
   (same pattern but use ct_mode prompt, call start_column_trace + submit_hop_analysis)
   Report: chain_path, column_renames, branches, source_nodes, pruned_nodes
   ```

4. **Parse agent result** — extract the JSON fields from agent output

5. **Save raw result** to `{run-dir}/{test-id}.json`

---

## Phase 2: Score (Correctness-First)

For each test result, run deterministic checks against `expected` from eval-suite.yaml:

### Check Table

| Check | Logic | Verdict |
|-------|-------|---------|
| **node_coverage** | every `nodes_required` present in `nodes_found` (case-insensitive substring match) | FAIL if any missing |
| **node_precision** | no `nodes_forbidden` present in `nodes_found` | FAIL if any present |
| **delivery_mode** | `delivery` matches expected | FAIL if wrong |
| **chain_path** (CT) | ordered chain matches expected path | FAIL if wrong order or missing nodes |
| **chain_length** (CT) | `chain_length_min` ≤ actual chain length | FAIL if below |
| **branches** (CT) | count matches expected | WARN if different |
| **column_renames** (CT) | count ≥ `column_renames_min` | FAIL if below |
| **source_nodes** (CT) | all expected sources found | FAIL if any missing |
| **prune_correctness** | `nodes_forbidden` not in result AND `nodes_required` not pruned | WARN if utilities kept |
| **hop_count** | ≤ `max_hops` | WARN if exceeded |
| **completion** | agent completed without hitting round limit | FAIL if stuck |

### Grading

- **PASS**: all checks PASS (WARNs allowed)
- **PARTIAL**: no FAIL on node_coverage or chain_path, but has other FAILs
- **FAIL**: any FAIL on node_coverage, chain_path, delivery_mode, or completion

Save `{run-dir}/scores.json` with per-test score cards.

---

## Phase 3: Deep Investigation (for each FAIL/PARTIAL)

Before recommending fixes, replay each failing test MANUALLY against the bridge to find the EXACT root cause. Do not blame the model without evidence.

### 3a. Manual Replay

For each failing test, call bridge tools directly via curl step by step:
1. `POST /session` → create session
2. `POST /tool` with `start_column_trace` or `start_exploration` → capture FULL response JSON
3. Extract correct field values from response (e.g. `focus_node.id`)
4. `POST /tool` with correct submit call → verify SM works with valid input
5. Continue hop by hop — save each response to `{run-dir}/{test-id}-replay-hopN.json`
6. This proves whether the SM is correct. Then compare against what the Haiku agent actually sent.

### 3b. Rejection Classification

For EVERY error response from the SM, classify:

| Classification | Meaning | Action |
|---------------|---------|--------|
| **HALLUCINATION** | AI invented a value not in model or SM response | Count it. Model limitation. |
| **DESIGN_CONFUSION** | Correct value was in SM response but AI extracted wrong — our prompt/structure is ambiguous | **OUR bug.** Fix prompt or response format. |
| **VALID_REJECTION** | SM correctly rejected a logically wrong action | Working as intended. |

For each rejection, record in `{run-dir}/rejections.json`:
```json
{"hop": N, "tool": "submit_hop_analysis", "error_type": "focus_mismatch",
 "ai_sent": "undefined", "sm_expected": "[ai].[spbuildsalesreport]",
 "was_value_in_prior_response": true,
 "classification": "DESIGN_CONFUSION",
 "reason": "modelDescription says 'from hop context' without showing nested path focus_node.id",
 "fix": "Clarify extraction in modelDescription"}
```

**Target: DESIGN_CONFUSION = 0.**

### 3c. Iterative Fix-and-Test (SMALL CHANGES ONLY)

**Test on bridge FIRST, then update extension code.**

1. Make ONE small change to the bridge server prompt (`test-internal/ai-test-server.ts`)
2. Commit it locally
3. Restart bridge server (`npx tsx test-internal/ai-test-server.ts [dacpac]`)
4. Re-run the specific failing test via Haiku agent
5. **If fix works on bridge** → apply same change to extension code (`src/extension.ts`, `package.json`), commit, push, update journal
6. **If fix doesn't help** → `git revert` the commit, try different approach
7. Never batch multiple unrelated fixes — isolate each change so rollback is clean

### 3d. Investigation Journal

Maintain a sliding task list in `.claude/plans/*.md` (the plan file for the active eval conversation). Format:

```markdown
## Current: [what you're working on right now]

| # | Issue | Status |
|---|-------|--------|
| 1 | description | RESOLVED ✓ / INVESTIGATING / TODO |
| 2 | description | TODO |

## Done Log
- [date] Issue #1: [what was done] → [result] → [commit hash]
- [date] Issue #2: ...

## Next Steps
- Issue #N: [what to investigate next]
```

This journal persists across conversation turns. Always update it after each fix-and-test cycle.

### 3d. Baseline Compare

1. Load baseline from `tmp/eval-runs/baseline.json` (skip if no baseline)
2. PASS → FAIL = **REGRESSION**, FAIL → PASS = **IMPROVEMENT**, same = **STABLE**

### Reference Documents

- `tmp/eval-runs/run-*/ct-analysis.md` — CT SM architecture analysis (lifecycle, response formats, code locations)
- `tmp/eval-runs/run-*/scores.json` — per-test score cards
- `.claude/plans/*.md` — investigation tracker with issue backlog

### Important: Bridge server has its OWN prompts

The bridge server in `test-internal/ai-test-server.ts` has hardcoded `CT_MODE_PROMPT`, `BB_MODE_PROMPT`, `SYSTEM_PROMPT`. Served via `GET /prompts`. When fixing prompts, update BOTH:
1. `src/extension.ts` (real extension)
2. `test-internal/ai-test-server.ts` (bridge — what eval agents actually see)
3. `package.json` modelDescription (tool descriptions)

---

## Phase 4: Summary Dashboard

Write `{run-dir}/summary.md` and display to user:

```markdown
# Eval Run — {timestamp}

## Results
| Test | Grade | Key Checks | vs Baseline |
|------|-------|------------|-------------|
| bb-q1-employee | PASS | 12/12 nodes, inline | STABLE |
| ... | ... | ... | ... |

## Regressions
- {test}: {check} FAIL — {detail}

## Recommendations
1. [{category}] {title} — WHY: {rationale} — FIX: {file:line} — RISK: {level}
```

---

## Phase 5: Human Gate

Present each recommendation. Ask user to approve or reject.

---

## Phase 6: Apply + Retest (on approval)

1. Apply approved changes to code
2. Rerun full eval suite (Phase 1-4)
3. Verify: target metric improved? Any regressions?
4. If improved + no regressions:
   - Update `tmp/eval-runs/baseline.json` with new scores
   - Log applied fix to `tmp/eval-runs/knowledge.json`
5. If regressed:
   - Revert change
   - Log failure to `tmp/eval-runs/knowledge.json` with reason

---

## Knowledge Accumulation

Before generating recommendations in Phase 3, read `tmp/eval-runs/knowledge.json`:
- Don't re-recommend fixes that previously failed
- Group recurring root causes into single recommendations
- Reference prior successful fixes as patterns

---

## Important Notes

- One dacpac at a time — if tests span multiple dacpacs, process each group separately
- Per-hop agents: each hop gets a FRESH Haiku agent (compacted history for prior hops) — this matches real VS Code Copilot behavior
- Node name matching is case-insensitive substring (SQL Server CI mode)
- The bridge server uses the same dispatchTool, SM code, and prompts as the real extension — full parity
- Customer dacpac data must never appear in logs, commits, or recommendations
