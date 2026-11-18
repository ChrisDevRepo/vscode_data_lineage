import { z } from 'zod';

/**
 * Structural reject code: a `{upstream,downstream}` depth with both sides `levels: 0`, which would
 * seed an empty starting scope. Single source of truth, interpolated by every surface that emits or
 * maps it (the Zod issue tag here and the reject-hint mapper in `startExplorationRules.ts`) so a
 * rename cannot drift.
 */
export const ASYMMETRIC_DEPTH_BOTH_ZERO = 'asymmetric_depth_both_zero';

/** Canonical unsigned-integer string shape a depth scalar decodes from. */
const CANONICAL_DEPTH_DIGITS = /^(?:0|[1-9]\d*)$/;

/**
 * Decodes a JSON-string-encoded non-negative integer (`"2"`) into its number before validation.
 * Only a canonical unsigned integer literal is unwrapped; every other value (`"1.5"`, `"-1"`, `""`,
 * a boolean, an object) passes through so the wrapped schema's own rejection surfaces. Deliberately
 * NOT `z.coerce.number()`, which also turns `true` and `null` into `1`/`0`. The wrapped bounds
 * still decide the value (a top-level `"0"` stays rejected by `.min(1)`).
 *
 * Callers wrap the full `levels`/`all` union with this, never one union member alone: Zod 4's `io:
 * 'input'` JSON Schema projection reads a union's required-ness from each member's raw `optin`, and
 * a preprocess member's `optin` is "optional" (a transform accepts any input), so one wrapped
 * member would mark the whole union optional in the served schema. Wrapping the union as a single
 * preprocess input keeps the field's `optin` resolved to the members (`false`), and is transparent
 * to `z.toJSONSchema` since it only forwards a canonical unsigned-integer string to the number
 * branch, leaving the served `anyOf` unchanged.
 *
 * @param schema - The `levels`-shaped schema (a numeric bound, or a `number | 'all'` union) to
 *   wrap.
 */
export function numericStringDepth<T extends z.ZodType>(schema: T) {
  return z.preprocess(
    (value) => (typeof value === 'string' && CANONICAL_DEPTH_DIGITS.test(value) ? Number(value) : value),
    schema,
  );
}

/**
 * One AI-selected depth limit for a post-synthesis supplement chain, the only surviving scalar
 * depth field; `lineage_start_exploration` depth is always the per-side shape below.
 */
export const ExplorationDepthLimitSchema = numericStringDepth(z.union([z.number().int().min(1), z.literal('all')]));

/** One side's depth verdict: how far to start, and whether that count is a border. */
export interface DepthSideValue {
  /** Starting level count for this side, or `'all'` for the full chain. */
  levels: number | 'all';
  /**
   * `'exact'`: a limit the user stated, enforced as a border. `'approximate'`: your own estimate.
   */
  exactness: 'exact' | 'approximate';
}

/**
 * One side of the exploration border. `levels: 0` PERMANENTLY disables that direction for the
 * session (no starting seed, and every later route/contraction admission that way is rejected at
 * `isReachableInApprovedDirection` in `smBase.ts`), whatever the `exactness`. An `'exact'` side is
 * walked to `levels` as a hard border; an `'approximate'` side is the plan's estimate, not a
 * border: its walk and scope preview cover everything the active filters and the graph's edges
 * admit that way.
 */
const DepthSideSchema: z.ZodType<DepthSideValue> = z.object({
  levels: numericStringDepth(z.union([z.number().int().min(0), z.literal('all')])),
  exactness: z.enum(['exact', 'approximate']),
}).strict();

/** True when the two sides carry different verdicts (`levels` or `exactness`). */
export function depthSidesDiffer(upstream: DepthSideValue, downstream: DepthSideValue): boolean {
  return upstream.levels !== downstream.levels || upstream.exactness !== downstream.exactness;
}

/** True when both sides are permanently closed — an empty starting scope. */
export function bothSidesClosed(upstream: DepthSideValue, downstream: DepthSideValue): boolean {
  return upstream.levels === 0 && downstream.levels === 0;
}

/**
 * Traversal direction a per-side depth implies: a closed side (`levels: 0`) is a hard border, so
 * direction is read off depth and never carried as a second field that could contradict it.
 * `'upstream'` when downstream is closed, `'downstream'` when upstream is closed, else
 * `'bidirectional'` (both closed is rejected before this is consulted).
 */
export function directionFromDepth(depth: { upstream: DepthSideValue; downstream: DepthSideValue }): 'upstream' | 'downstream' | 'bidirectional' {
  if (depth.downstream.levels === 0) return 'upstream';
  if (depth.upstream.levels === 0) return 'downstream';
  return 'bidirectional';
}

/**
 * Required starting depth for `lineage_start_exploration`, one verdict per side. There is no
 * "unstated" side and no backend default: every call carrying `depth` names a level and an
 * exactness for both `upstream` and `downstream`.
 */
export const ExplorationDepthSelectionSchema = z.object({
  upstream: DepthSideSchema,
  downstream: DepthSideSchema,
}).strict().superRefine((data, ctx) => {
  if (bothSidesClosed(data.upstream, data.downstream)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Depth cannot be 0 in both directions.',
      params: { startIssue: ASYMMETRIC_DEPTH_BOTH_ZERO },
    });
  }
});
