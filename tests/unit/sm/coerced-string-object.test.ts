import { z } from 'zod';
import { coercedStringObject } from '../../../src/ai/support/inputNormalization';
import { ExplorationDepthSelectionSchema } from '../../../src/engine/shared/explorationDepthContract';
import { resolveDepthIntent } from '../../../src/ai/sm/smTypes';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';
import {
  StartExplorationFreshProviderInputSchema,
  StartExplorationInputSchema,
} from '../../../src/ai/tools/toolSchemas';
import { describe, expect, it } from 'vitest';

/**
 * Class: a local OpenAI-compatible provider (Qwen/oMLX lane) emitting an object-typed tool
 * argument as a JSON string. Reproduced 2026-08-30 on prompt T4 (local-mlx): the model sent
 * `depth: "{\"upstream\": 1, \"downstream\": 1}"` with every other argument valid, the strict
 * union rejected it as `invalid_tool_input` three times, and the turn stopped on cumulative
 * semantic failures. The provider repeats the identical encoding on every repair attempt —
 * the defect is transport-side, so the boundary must decode it, not ask the model to fix it.
 */
describe('coerced-string-object tests', () => {
  const T4_DEPTH_STRING = '{"upstream": 1, "downstream": 1}';
  const freshBb = (depth: unknown) => ({
    origin: '[ai].[raworderimport]',
    analysisMode: 'bb' as const,
    classification: 'business' as const,
    direction: 'bidirectional' as const,
    depth,
  });

  it('decodes the observed string-encoded asymmetric depth (handler boundary)', () => {
    const parsed = StartExplorationInputSchema.safeParse(freshBb(T4_DEPTH_STRING));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.depth).toEqual({ upstream: 1, downstream: 1 });
  });

  it('decodes the observed string-encoded asymmetric depth (provider boundary)', () => {
    const parsed = StartExplorationFreshProviderInputSchema.safeParse(freshBb(T4_DEPTH_STRING));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.depth).toEqual({ upstream: 1, downstream: 1 });
  });

  it('decoded depth resolves to the asymmetric engine intent', () => {
    const parsed = StartExplorationInputSchema.safeParse(freshBb(T4_DEPTH_STRING));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(resolveDepthIntent(parsed.data.depth)).toEqual({
      kind: 'asymmetric',
      upstream: 1,
      downstream: 1,
    });
  });

  it('genuine object depth remains valid (passthrough)', () => {
    expect(StartExplorationInputSchema.safeParse(freshBb({ upstream: 2, downstream: 0 })).success).toBe(true);
  });

  it('symmetric integer depth remains valid', () => {
    const parsed = StartExplorationInputSchema.safeParse(freshBb(2));
    expect(parsed.success && parsed.data.depth).toBe(2);
  });

  it("'all' literal depth remains valid (JSON.parse failure passthrough)", () => {
    const parsed = StartExplorationInputSchema.safeParse(freshBb('all'));
    expect(parsed.success && parsed.data.depth).toBe('all');
  });

  it('a quoted JSON scalar is NOT unwrapped by the object-only allowlist (still rejected)', () => {
    // '"2"' parses to the JS string "2" (quotes as content), which is neither a JSON object nor
    // a canonical bare integer literal, so it passes through both preprocess layers untouched.
    expect(StartExplorationInputSchema.safeParse(freshBb('"2"')).success).toBe(false);
  });

  it('a bare numeric string now normalizes on the depth branch itself (engine/shared, not this allowlist)', () => {
    // '2' is not a JSON object, so coercedStringObject passes it through unchanged; it is
    // ExplorationDepthLimitSchema's own numericStringDepth preprocess (explorationDepthContract.ts)
    // that unwraps a canonical bare integer literal — one normalization policy for both depth
    // encodings, fixing the local-mlx T4/T8S stop where `depth: "1"`/`"2"` was rejected three
    // times while the asymmetric object form accepted the identical encoding.
    const parsed = StartExplorationInputSchema.safeParse(freshBb('2'));
    expect(parsed.success && parsed.data.depth).toBe(2);
  });

  it('non-JSON string remains rejected', () => {
    expect(StartExplorationInputSchema.safeParse(freshBb('not json {')).success).toBe(false);
  });

  it('string-encoded array is NOT unwrapped (object-only allowlist)', () => {
    expect(StartExplorationInputSchema.safeParse(freshBb('[1,2]')).success).toBe(false);
  });

  it('string-encoded string-encoded (doubled) object is NOT unwrapped', () => {
    // `"{\\"{\\"upstream\\": 1\\"}"` — a string wrapping a string wrapping an object parses to a
    // string, not an object, so it passes through and the union's own rejection surfaces.
    expect(StartExplorationInputSchema.safeParse(freshBb(`"${T4_DEPTH_STRING.replace(/"/g, '\\"')}"`)).success).toBe(false);
  });

  it('invalid object contents still reject after decode (strictness survives)', () => {
    expect(StartExplorationInputSchema.safeParse(freshBb('{"garbage": 1}')).success).toBe(false);
    expect(StartExplorationInputSchema.safeParse(freshBb('{"upstream": "x", "downstream": 1}')).success).toBe(false);
  });

  it('both-zero asymmetric depth still rejects after decode (structural guard survives)', () => {
    expect(StartExplorationInputSchema.safeParse(freshBb('{"upstream": 0, "downstream": 0}')).success).toBe(false);
  });

  it('decoded asymmetric depth with non-bidirectional direction still rejects (conflict survives decode)', () => {
    const parsed = StartExplorationFreshProviderInputSchema.safeParse({
      ...freshBb(T4_DEPTH_STRING),
      direction: 'upstream' as const,
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(JSON.stringify(parsed.error.issues)).toContain('asymmetric_depth_requires_bidirectional');
  });

  it('depth model schema renders byte-identical to the unwrapped union (model-facing contract unchanged)', () => {
    const wrapped = toModelJsonSchema(z.object({
      depth: coercedStringObject(ExplorationDepthSelectionSchema).nullable().optional(),
    }));
    const plain = toModelJsonSchema(z.object({
      depth: ExplorationDepthSelectionSchema.nullable().optional(),
    }));
    expect(JSON.stringify(wrapped)).toBe(JSON.stringify(plain));
  });
});
