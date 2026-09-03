import { z } from 'zod';

/**
 * Structural reject code: an asymmetric `{upstream,downstream}` depth with both sides `0`,
 * which would seed an empty starting scope. Single source of truth — interpolated by every
 * surface that emits or maps this code (the Zod issue tag here, and the reject-hint mapper in
 * `startExplorationRules.ts`) so a rename cannot drift silently between them.
 */
export const ASYMMETRIC_DEPTH_BOTH_ZERO = 'asymmetric_depth_both_zero';

/**
 * Structural reject code: an asymmetric `{upstream,downstream}` depth paired with an explicit
 * non-bidirectional direction. Single source of truth — interpolated by every surface that
 * emits or maps this code (the provider-schema `superRefine` in `toolSchemas.ts`, the runtime
 * engine guard in `smBase.ts`, and the reject-hint mapper in `startExplorationRules.ts`) so a
 * rename cannot drift silently between them.
 */
export const ASYMMETRIC_DEPTH_REQUIRES_BIDIRECTIONAL = 'asymmetric_depth_requires_bidirectional';

/**
 * Decodes a JSON-string-encoded non-negative integer (`"2"`) into its number before validation.
 *
 * @remarks
 * Encoding-only normalization per the middleware contract, and the depth-scalar sibling of
 * `coercedStringArray` / `coercedStringObject` / `coercedBoolean` in `ai/support/
 * inputNormalization.ts` — kept here rather than imported from there because `engine/shared`
 * must not reach into `src/ai/**`. Only a canonical unsigned integer literal is unwrapped; every
 * other value (`"1.5"`, `"-1"`, `""`, `"all"`, a pseudo-XML blob, a boolean, an object) passes
 * through untouched so the wrapped schema's own rejection surfaces unchanged. Deliberately NOT
 * `z.coerce.number()` — that also turns `true` and `null` into `1`/`0`, accepting an input whose
 * intent was never a depth. The wrapped bounds still decide the value: a top-level `"0"` remains
 * rejected by `.min(1)`. Transparent to `z.toJSONSchema` (`io: 'input'`), so the model-facing
 * tool schema is byte-identical to today's.
 *
 * @param schema - The numeric schema to wrap, with its own `.int()` and bounds applied.
 * @returns The preprocess-wrapped schema; output type is identical to the wrapped schema.
 */
function numericStringDepth<T extends z.ZodType>(schema: T) {
  return z.preprocess(
    (value) => (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value) ? Number(value) : value),
    schema,
  );
}

/**
 * One AI-selected starting depth for hop-by-hop exploration.
 *
 * @remarks
 * The numeric branch is wrapped in {@link numericStringDepth} for the same reason as
 * {@link ExplorationDepthSideSchema}: this branch is also rendered next to the quoted literal
 * `'all'` in the same `anyOf`, so it invites a provider to quote the number too. Observed
 * 2026-09-03 (prompts T4 and T8S, local-mlx): `depth: "1"` / `"2"` was rejected three times as
 * `invalid_tool_input` and stopped the turn on cumulative semantic failures at `sm_entry`, while
 * the asymmetric sibling accepted the identical encoding — one union, two opposite policies.
 */
const ExplorationDepthLimitSchema = z.union([numericStringDepth(z.number().int().min(1)), z.literal('all')]);

/**
 * One side of an asymmetric depth pair. Unlike {@link ExplorationDepthLimitSchema}, 0 is a
 * valid side value here — it PERMANENTLY disables that direction for the rest of the session
 * (no starting seed, and every later route/contraction admission in that direction is rejected
 * at {@link BorderPurpose} `'route'`/`'ct_contraction'` — see `isReachableInApprovedDirection` in
 * `smBase.ts`), the mechanism for a lopsided proposal (e.g. `{upstream: 2, downstream: 0}`).
 * Omitted/`null` is a distinct "unstated" signal — it resolves to the reviewed default of 3,
 * independently per side, exactly like the top-level {@link ExplorationDepthSelectionSchema}.
 * {@link numericStringDepth} on the numeric branch for the same reason as
 * {@link ExplorationDepthLimitSchema}.
 */
const ExplorationDepthSideSchema = z.union([numericStringDepth(z.number().int().min(0)), z.literal('all')]);

/**
 * Independent starting depths for a bidirectional exploration proposal. Each side independently
 * accepts a positive integer, `"all"`, `0` (permanently disables that direction), or omitted/
 * `null` (defaults to 3 — see {@link resolveDepthIntent} in `smTypes.ts`). Both sides `0` is
 * structurally rejected — that combination seeds an empty scope, which is never intentional.
 */
const AsymmetricExplorationDepthSchema = z.object({
  upstream: ExplorationDepthSideSchema.nullable().optional().describe('Starting upstream levels; 0 permanently disables upstream exploration for the rest of the session. Use "all" only when the user explicitly asked for the full upstream chain. Omitted/null defaults to 3.'),
  downstream: ExplorationDepthSideSchema.nullable().optional().describe('Starting downstream levels; 0 permanently disables downstream exploration for the rest of the session. Use "all" only when the user explicitly asked for the full downstream chain. Omitted/null defaults to 3.'),
}).strict().superRefine((data, ctx) => {
  if (data.upstream === 0 && data.downstream === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Asymmetric depth cannot be 0 in both directions.',
      params: { startIssue: ASYMMETRIC_DEPTH_BOTH_ZERO },
    });
  }
});

/** AI-selected starting scope. Omission is the declared mechanical default of 3. */
export const ExplorationDepthSelectionSchema = z.union([
  ExplorationDepthLimitSchema,
  AsymmetricExplorationDepthSchema,
]);
