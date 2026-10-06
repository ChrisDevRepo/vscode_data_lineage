import { z } from 'zod';

/**
 * Structural reject code: a `{upstream,downstream}` depth with both sides `levels: 0`, which
 * would seed an empty starting scope. Single source of truth — interpolated by every surface
 * that emits or maps this code (the Zod issue tag here, and the reject-hint mapper in
 * `startExplorationRules.ts`) so a rename cannot drift silently between them.
 */
export const ASYMMETRIC_DEPTH_BOTH_ZERO = 'asymmetric_depth_both_zero';

/** Canonical unsigned-integer string shape a depth scalar decodes from. */
const CANONICAL_DEPTH_DIGITS = /^(?:0|[1-9]\d*)$/;

/**
 * Decodes a JSON-string-encoded non-negative integer (`"2"`) into its number before validation.
 *
 * @remarks
 * Only a canonical unsigned integer literal is unwrapped; every other value (`"1.5"`, `"-1"`,
 * `""`, a boolean, an object) passes through untouched so the wrapped schema's own rejection
 * surfaces unchanged. Deliberately NOT `z.coerce.number()` — that also turns `true` and `null`
 * into `1`/`0`, accepting an input whose intent was never a depth.
 * The wrapped bounds still decide the value: a top-level `"0"` remains rejected by `.min(1)`.
 *
 * @remarks
 * Callers wrap the full `levels`/`all` union with this function — never one union member alone
 * (`z.union([numericStringDepth(z.number()), z.literal('all')])`) — because Zod 4's `io: 'input'`
 * JSON Schema projection reads a union's own required-ness from the raw `optin` of each member: a
 * preprocess member's `optin` is its transform's ("optional", since a transform function accepts
 * any input), so one preprocess-wrapped member marks the whole union optional in the served schema
 * even though every member, including the wrapped one, still resolves to a required value.
 * Wrapping the union as a single preprocess input keeps the field's own `optin` resolved past the
 * transform straight to the union's members (`false`), and is transparent to `z.toJSONSchema`
 * (`io: 'input'`): the preprocess only ever forwards a canonical unsigned-integer string to the
 * number branch, so the served `anyOf` shape is unchanged.
 *
 * @param schema - The `levels`-shaped schema (a numeric bound, or a `number | 'all'` union) to wrap.
 * @returns The preprocess-wrapped schema; output type is identical to the wrapped schema.
 */
export function numericStringDepth<T extends z.ZodType>(schema: T) {
  return z.preprocess(
    (value) => (typeof value === 'string' && CANONICAL_DEPTH_DIGITS.test(value) ? Number(value) : value),
    schema,
  );
}

/**
 * One AI-selected depth limit for a post-synthesis supplement chain — the only surviving scalar
 * depth field; `lineage_start_exploration` depth is always the per-side shape below.
 */
export const ExplorationDepthLimitSchema = numericStringDepth(z.union([z.number().int().min(1), z.literal('all')]));

/** One side's depth verdict: how far to start, and whether that count is a border. */
export interface DepthSideValue {
  /** Starting level count for this side, or `'all'` for the full chain. */
  levels: number | 'all';
  /** `'exact'`: a limit the user stated, enforced as a border. `'approximate'`: your own estimate. */
  exactness: 'exact' | 'approximate';
}

/**
 * One side of the exploration border.
 *
 * @remarks
 * `levels: 0` PERMANENTLY disables that direction for the rest of the session (no starting seed,
 * and every later route/contraction admission in that direction is rejected at
 * `isReachableInApprovedDirection` in `smBase.ts`), regardless of `exactness`. An `'exact'` side
 * is walked to `levels` and enforced as a hard border; an `'approximate'` side is the estimate the
 * plan shows, not a border — its walk and the scope preview cover everything the active filters and
 * the graph's own edge admit on that side.
 */
const DepthSideSchema: z.ZodType<DepthSideValue> = z.object({
  levels: numericStringDepth(z.union([z.number().int().min(0), z.literal('all')]))
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

/**
 * Traversal direction a per-side depth implies: a closed side (`levels: 0`) is a hard border for
 * that direction, so direction is read off depth here and never carried as a second field that
 * could contradict it.
 *
 * @returns `'upstream'` when downstream is closed, `'downstream'` when upstream is closed,
 *   `'bidirectional'` otherwise (both closed is rejected before this is consulted).
 */
export function directionFromDepth(depth: { upstream: DepthSideValue; downstream: DepthSideValue }): 'upstream' | 'downstream' | 'bidirectional' {
  if (depth.downstream.levels === 0) return 'upstream';
  if (depth.upstream.levels === 0) return 'downstream';
  return 'bidirectional';
}

/**
 * Required starting depth for `lineage_start_exploration`, one verdict per side.
 *
 * @remarks
 * There is no "unstated" side and no backend-supplied default: every call that carries `depth`
 * names a level and an exactness for both `upstream` and `downstream`.
 */
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
