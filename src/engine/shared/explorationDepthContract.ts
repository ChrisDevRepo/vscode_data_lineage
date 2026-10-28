import { z } from 'zod';

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
export function bothSidesClosed(upstream: { readonly levels: unknown }, downstream: { readonly levels: unknown }): boolean {
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
      message: 'Depth cannot be 0 in both directions; set at least one side to ≥ 1 or "all".',
    });
  }
}).meta({ toolDepthOpen: true });
