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

/** One AI-selected starting depth for hop-by-hop exploration. */
const ExplorationDepthLimitSchema = z.union([z.number().int().min(1), z.literal('all')]);

/**
 * One side of an asymmetric depth pair. Unlike {@link ExplorationDepthLimitSchema}, 0 is a
 * valid side value here — it PERMANENTLY disables that direction for the rest of the session
 * (no starting seed, and every later route/contraction admission in that direction is rejected
 * at {@link BorderPurpose} `'route'`/`'ct_contraction'` — see `isReachableInApprovedDirection` in
 * `smBase.ts`), the mechanism for a lopsided proposal (e.g. `{upstream: 2, downstream: 0}`).
 * Omitted/`null` is a distinct "unstated" signal — it resolves to the reviewed default of 3,
 * independently per side, exactly like the top-level {@link ExplorationDepthSelectionSchema}.
 */
const ExplorationDepthSideSchema = z.union([z.number().int().min(0), z.literal('all')]);

/**
 * Independent starting depths for a bidirectional exploration proposal. Each side independently
 * accepts a positive integer, `"all"`, `0` (permanently disables that direction), or omitted/
 * `null` (defaults to 3 — see {@link resolveDepthIntent} in `smTypes.ts`). Both sides `0` is
 * structurally rejected — that combination seeds an empty scope, which is never intentional.
 */
export const AsymmetricExplorationDepthSchema = z.object({
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
