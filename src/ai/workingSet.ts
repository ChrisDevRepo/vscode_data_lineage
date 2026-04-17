/**
 * Working-set selection for SM hop context.
 *
 * @remarks
 * Produces the `local_detail_context` slice injected into `working_memory` every hop.
 * One policy for all `SmMode` values (`blackboard` | `column_trace` | `dependency`) — operates
 * on graph structure and a token budget only, never on slot content or mode. Applied only
 * in SM mode; inline mode short-circuits because `AiMemoryManager.getResult()` already
 * delivers the full detail archive at synthesis.
 *
 * Selection algorithm:
 * 1. **PathFrame** — DetailSlots on the shortest `origin → focus` path, excluding focus.
 *    Always included; may overspend the budget (structural continuity is non-negotiable).
 * 2. **BranchLocal (near)** — 1-hop neighbors of focus (bidirectional), minus path and focus.
 * 3. **BranchLocal (far)** — 2-hop neighbors of focus, minus path, focus, and near.
 * 4. **Budget pack** — path slots entered first (unconditional), then near, then far, each
 *    skipped if adding would cross the budget. Deterministic: within each tier, sorted by id.
 * 5. **Emission order** — `[path → near → far]` (breadcrumbs first, then nearest evidence).
 *
 * Grounding: Working Set Theory (Denning, 1968); MemGPT two-tier memory (Packer et al., 2023);
 * GraphRAG local-mode retrieval (Edge et al., Microsoft 2024).
 *
 * Side effects: none (pure function). Thread-safety: safe — reads only.
 */

import type Graph from 'graphology';
import { bidirectional } from 'graphology-shortest-path/unweighted';
import type { DetailSlot } from './memoryManager';

/**
 * Soft cap on total tokens for the per-hop detail slice.
 *
 * @remarks
 * ≈ 16 000 chars ≈ 3–4 fat SP analyses or 10–15 thinner ones. About 25 % of a 16 K context
 * window, leaving room for system prompt, blackboard, focus DDL, neighbor metadata, the
 * topological map, and chat history. Tune on eval metrics; do **not** compute at runtime.
 */
export const WORKING_SET_TOKEN_BUDGET = 4000;

/**
 * Heuristic token cost per character for technical English + SQL.
 *
 * @remarks
 * Kept as a single constant so `cost()` stays trivial and per-slot estimation is
 * consistent across the module. Real tokenizer counts would be more accurate but add a
 * runtime dep for marginal gain — budget is a soft cap, not a hard limit.
 */
const TOKENS_PER_CHAR = 0.25;

/**
 * Parameters required to compute the per-hop working set.
 *
 * @remarks
 * Supplied by `NavigationEngine.getHopContext()` in SM mode. Inline mode passes
 * `undefined` so `AiMemoryManager.getWorkingMemory` skips the selection entirely.
 */
export interface WorkingSetContext {
  /** The node currently under analysis (agenda-dequeued this hop). */
  focusId: string;
  /** The session's starting node (fixed at `init()` time). Used to compute the PathFrame. */
  originId: string;
  /** The shared graphology instance driving the traversal. */
  graph: Graph;
}

/**
 * Selects a budget-bounded, path-prioritized DetailSlot slice for the current hop.
 *
 * See the module docstring for the full algorithm and grounding references.
 *
 * @param ctx - Focus, origin, and graph for this hop.
 * @param slots - The full DetailSlot storage (`AiMemoryManager.detailSlots`). Read-only.
 * @param budget - Token budget for non-path tiers. Defaults to {@link WORKING_SET_TOKEN_BUDGET}.
 * @returns Ordered DetailSlot list ready to inject into `working_memory.local_detail_context`.
 *          Empty array if `slots` is empty.
 */
export function selectWorkingSet(
  ctx: WorkingSetContext,
  slots: ReadonlyMap<string, DetailSlot>,
  budget: number = WORKING_SET_TOKEN_BUDGET,
): DetailSlot[] {
  if (slots.size === 0) return [];

  const path = pathSlots(ctx.graph, ctx.originId, ctx.focusId, slots);
  const exclude = new Set(path.map(s => s.nodeId));
  exclude.add(ctx.focusId);
  const { near, far } = branchLocal(ctx.graph, ctx.focusId, slots, exclude);

  const out: DetailSlot[] = [];
  let tokens = 0;
  // Tier 1: path slots — unconditional (may overspend budget).
  for (const s of path) {
    out.push(s);
    tokens += cost(s);
  }
  // Tier 2+3: near then far, each gated by remaining budget.
  for (const s of [...near, ...far]) {
    const c = cost(s);
    if (tokens + c > budget) continue;
    out.push(s);
    tokens += c;
  }
  return out;
}

/** Estimated token cost of a slot's analysis body. */
function cost(s: DetailSlot): number {
  return Math.ceil(s.analysis.length * TOKENS_PER_CHAR);
}

/**
 * DetailSlots on the shortest `origin → focus` path, excluding the focus itself.
 *
 * @remarks
 * Uses graphology's `bidirectional` (undirected shortest path) so upstream and downstream
 * traces behave symmetrically. Column-trace direction semantics are already baked into
 * each slot's analysis text at storage time; the selector stays topology-based.
 */
function pathSlots(
  graph: Graph,
  originId: string,
  focusId: string,
  slots: ReadonlyMap<string, DetailSlot>,
): DetailSlot[] {
  if (originId === focusId) return [];
  const p = bidirectional(graph, originId, focusId) as string[] | null;
  if (!p || p.length <= 1) return [];
  const out: DetailSlot[] = [];
  for (let i = 0; i < p.length - 1; i++) {
    const slot = slots.get(p[i]);
    if (slot) out.push(slot);
  }
  return out;
}

/**
 * 1-hop and 2-hop neighbors of `focusId` (bidirectional), sorted by id, minus `exclude`.
 *
 * @remarks
 * Uses `graph.neighbors()` which already returns inbound + outbound, deduped — no
 * hand-rolled BFS is required for a fixed 2-level enumeration.
 */
function branchLocal(
  graph: Graph,
  focusId: string,
  slots: ReadonlyMap<string, DetailSlot>,
  exclude: ReadonlySet<string>,
): { near: DetailSlot[]; far: DetailSlot[] } {
  const oneHop = new Set<string>();
  for (const id of graph.neighbors(focusId) as string[]) {
    if (!exclude.has(id)) oneHop.add(id);
  }

  const twoHop = new Set<string>();
  for (const id of oneHop) {
    for (const n of graph.neighbors(id) as string[]) {
      if (n !== focusId && !exclude.has(n) && !oneHop.has(n)) twoHop.add(n);
    }
  }

  return { near: slotsOf(oneHop, slots), far: slotsOf(twoHop, slots) };
}

/** Deterministic sort-by-id + map-lookup helper used inside {@link branchLocal}. */
function slotsOf(ids: ReadonlySet<string>, slots: ReadonlyMap<string, DetailSlot>): DetailSlot[] {
  return Array.from(ids).sort().flatMap(id => (slots.get(id) ? [slots.get(id)!] : []));
}
