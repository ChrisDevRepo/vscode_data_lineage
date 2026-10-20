import { z } from 'zod';

/** Structural reject code: a `{upstream,downstream}` depth with both sides `levels: 0`, which would seed an empty starting scope. Single source of truth — interpolated by every surface that emits or maps this code (the Zod issue tag here, and the reject-hint mapper in `startExplorationRules.ts`) so a rename cannot drift silently between them. */
export const ASYMMETRIC_DEPTH_BOTH_ZERO = 'asymmetric_depth_both_zero';

/** One AI-selected depth limit for a post-synthesis supplement chain — the only surviving scalar depth field; `lineage_start_exploration` depth is always the per-side shape below. */
export const ExplorationDepthLimitSchema = z.union([z.number().int().min(1), z.literal('all')]);

/** One side's depth verdict: how far to start, and whether that count is a border. */
export interface DepthSideValue {
  /** Starting level count for this side, or `'all'` for the full chain. */
  levels: number | 'all';
  /** `'exact'`: a limit the user stated, enforced as a border. `'approximate'`: estimated depth. */
  exactness: 'exact' | 'approximate';
}

/** One side of the exploration border. */
const DepthSideSchema: z.ZodType<DepthSideValue> = z.object({
  levels: z.union([z.number().int().min(0), z.literal('all')])
    .describe('Starting level count for this side, or "all" for the full chain.'),
  exactness: z.enum(['exact', 'approximate'])
    .describe('"exact" is a limit the user stated, enforced as a border. "approximate" is your own estimate, shown on the plan; above 0 it does not bound the scope, which runs until the filters or the border stop it.'),
}).strict();

/** True when the two sides carry different verdicts (`levels` or `exactness`). */
export function depthSidesDiffer(upstream: DepthSideValue, downstream: DepthSideValue): boolean {
  return upstream.levels !== downstream.levels || upstream.exactness !== downstream.exactness;
}

/** True when both sides are permanently closed — an empty starting scope. */
export function bothSidesClosed(upstream: DepthSideValue, downstream: DepthSideValue): boolean {
  return upstream.levels === 0 && downstream.levels === 0;
}

/** Traversal direction a per-side depth implies: a closed side (`levels: 0`) is a hard border for that direction, so direction is read off depth here and never carried as a second field that could contradict it. */
export function directionFromDepth(depth: { upstream: DepthSideValue; downstream: DepthSideValue }): 'upstream' | 'downstream' | 'bidirectional' {
  if (depth.downstream.levels === 0) return 'upstream';
  if (depth.upstream.levels === 0) return 'downstream';
  return 'bidirectional';
}

/** Resolves the per-side ceilings, published budget and enforcement of an approved depth intent. */
export function resolveDepthBorder(depthIntent: { upstream: DepthSideValue; downstream: DepthSideValue }): {
  limits: { upstream: number; downstream: number };
  budget: number | null;
  enforcement: 'strict' | 'silent';
} {
  const sideCap = (side: DepthSideValue): number => {
    if (side.levels !== 0 && side.exactness !== 'exact') return Number.POSITIVE_INFINITY;
    return side.levels === 'all' ? Number.POSITIVE_INFINITY : side.levels;
  };
  const limits = { upstream: sideCap(depthIntent.upstream), downstream: sideCap(depthIntent.downstream) };
  const bothFinite = Number.isFinite(limits.upstream) && Number.isFinite(limits.downstream);
  return {
    limits,
    budget: bothFinite ? Math.max(limits.upstream, limits.downstream) : null,
    enforcement: Number.isFinite(limits.upstream) || Number.isFinite(limits.downstream) ? 'strict' : 'silent',
  };
}

/** Required starting depth for `lineage_start_exploration`, one verdict per side. */
export const ExplorationDepthSelectionSchema = z.object({
  upstream: DepthSideSchema.describe('Upstream starting depth.'),
  downstream: DepthSideSchema.describe('Downstream starting depth.'),
}).strict().superRefine((data, ctx) => {
  if (bothSidesClosed(data.upstream, data.downstream)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Depth cannot be 0 in both directions.',
      params: { startIssue: ASYMMETRIC_DEPTH_BOTH_ZERO },
    });
  }
});
