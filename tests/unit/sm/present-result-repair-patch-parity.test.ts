import { z } from 'zod';
import {
  PresentResultModelSchema,
  PresentResultRepairPatchSchema,
  PresentResultSynthesisModelSchema,
  presentResultRepairPatchSchemaForFields,
} from '../../../src/ai/tools/toolSchemas';
import { mergePresentResultRepairPatch } from '../../../src/ai/tools/presentResult';
import { describe, expect, it } from 'vitest';

describe("present_result repair-patch parity", () => {
  const GRAPH_EDIT_OR_CONTROL = new Set(['prune_node_ids', 'add_node_ids', 'is_update']);
  const fullKeys = Object.keys(PresentResultModelSchema.shape).filter((k) => !GRAPH_EDIT_OR_CONTROL.has(k));
  const patchKeys = new Set(Object.keys(PresentResultRepairPatchSchema.shape));
  it("repair-patch schema has no missing presentation field (drift)", () => {
    for (const key of fullKeys) {
      expect(patchKeys.has(key), `repair-patch schema is missing presentation field "${key}" — drift`).toBe(true);
    }
  });

  it("repair-patch is_update carries a repair-specific declared-default description (not the canonical one)", () => {
  const fullJsonSchema = z.toJSONSchema(PresentResultModelSchema) as { properties?: Record<string, { description?: string }> };
  const patchJsonSchema = z.toJSONSchema(PresentResultRepairPatchSchema) as { properties?: Record<string, { description?: string }> };
  // is_update intentionally diverges: in the repair patch it is an engine-declared default
  // (backfilled from the held-draft context), not a value the model must echo — so it carries a
  // repair-specific description rather than the canonical one.
  expect((patchJsonSchema.properties?.is_update?.description ?? '')
      !== (fullJsonSchema.properties?.is_update?.description ?? ''), 'repair-patch is_update carries a repair-specific declared-default description (not the canonical one)').toBe(true);
});

  it("repair patch must not accept prune_node_ids (graph edit)", () => { expect(!patchKeys.has('prune_node_ids'), 'repair patch must not accept prune_node_ids (graph edit)').toBe(true); });

  it("repair patch must not accept add_node_ids (graph edit)", () => { expect(!patchKeys.has('add_node_ids'), 'repair patch must not accept add_node_ids (graph edit)').toBe(true); });

  it("layout_direction specifically: a repair retry that echoes it back must not hard-reject.", () => {
  const parsed = PresentResultRepairPatchSchema.safeParse({
    is_update: true,
    layout_direction: 'LR',
    sections: [{ label: 'Overview', text: 'Corrected text.' }],
  });
  expect(parsed.success, 'repair patch accepts layout_direction').toBe(true);
});

  it("a minimal is_update-only patch is valid", () => { expect(PresentResultRepairPatchSchema.safeParse({ is_update: true }).success, 'a minimal is_update-only patch is valid').toBe(true); });

  it("a patch without is_update is valid (engine declares the default from the held-draft context)", () => { expect(PresentResultRepairPatchSchema.safeParse({ summary: 'x' }).success, 'a patch without is_update is valid (engine declares the default from the held-draft context)').toBe(true); });

  it("strict: unknown/forbidden key rejects", () => { expect(!PresentResultRepairPatchSchema.safeParse({ is_update: true, add_node_ids: ['n'] }).success, 'strict: unknown/forbidden key rejects').toBe(true); });

  it("Merge carries a patched layout_direction into the held draft.", () => {
  const draft = { name: 'n', summary: 's', layout_direction: 'TB', highlight_groups: [] } as never;
  const merged = mergePresentResultRepairPatch(draft, { is_update: true, layout_direction: 'LR' }, ['layout_direction']);
  expect(merged.layout_direction, 'merge carries a patched layout_direction into the held draft').toBe('LR');
});

  it("field-scoped schema accepts the authorized field", () => {
  const sectionsOnly = presentResultRepairPatchSchemaForFields(['sections']);
  expect(sectionsOnly.safeParse({ sections: [{ label: 'Overview', text: 'Corrected.' }] }).success, 'field-scoped schema accepts the authorized field').toBe(true);
  expect(!sectionsOnly.safeParse({ sections: [], summary: 'unauthorized' }).success, 'field-scoped schema rejects an additional known presentation field').toBe(true);
  const draft = { name: 'n', summary: 'original', sections: [], highlight_groups: [], notes: [] } as never;
  let threw = false;
  try {
    mergePresentResultRepairPatch(draft, { summary: 'unauthorized' }, ['sections']);
  } catch {
    threw = true;
  }
  expect(threw, 'merge defensively rejects unauthorized fields instead of silently ignoring them').toBe(true);
});

  it("excludes graph-edit/control fields and preserves full-render requiredness.", () => {
  const synthKeys = new Set(Object.keys(PresentResultSynthesisModelSchema.shape));
  for (const key of fullKeys) {
    expect(synthKeys.has(key), `synthesis schema is missing presentation field "${key}" — drift`).toBe(true);
  }
  // Graph-edit fields must NOT leak into the synthesis schema (prune/add are Completed-Phase only).
  expect(!synthKeys.has('prune_node_ids'), 'synthesis schema must not accept prune_node_ids (graph edit)').toBe(true);
  expect(!synthKeys.has('add_node_ids'), 'synthesis schema must not accept add_node_ids (graph edit)').toBe(true);
  // layout_direction specifically: a synthesis render that sets it must parse (the regression guarded).
  const parsed = PresentResultSynthesisModelSchema.safeParse({
    name: 'n', summary: 's', layout_direction: 'LR',
    highlight_groups: [{ label: 'Source', color: 'source', node_ids: ['a'] }],
    sections: [{ label: 'Overview', text: 'x' }],
  });
  expect(parsed.success, 'synthesis schema accepts layout_direction').toBe(true);
  expect(!synthKeys.has('is_update'), 'synthesis schema must not advertise held-repair/update control').toBe(true);
});

  it("are required, while unknown fields remain rejected.", () => {
  const validMinimalPayload = {
    name: 'n', summary: 's',
    highlight_groups: [{ label: 'Source', color: 'source' as const, node_ids: ['a'] }],
    sections: [{ label: 'Overview', text: 'x' }],
  };
  expect(PresentResultSynthesisModelSchema.safeParse(validMinimalPayload).success, 'sanity: the minimal payload itself is valid').toBe(true);
  expect(!PresentResultSynthesisModelSchema.safeParse({ ...validMinimalPayload, highlight_groups: [] }).success, 'strict synthesis schema enforces highlight_groups min(1)').toBe(true);
  expect(!PresentResultSynthesisModelSchema.safeParse({ ...validMinimalPayload, name: undefined }).success, 'strict synthesis schema requires name').toBe(true);
  expect(!PresentResultSynthesisModelSchema.safeParse({ ...validMinimalPayload, summary: undefined }).success, 'strict synthesis schema requires summary').toBe(true);
  expect(!PresentResultSynthesisModelSchema.safeParse({ ...validMinimalPayload, highlight_groups: undefined }).success, 'strict synthesis schema requires highlight_groups').toBe(true);
  expect(!PresentResultSynthesisModelSchema.safeParse({ ...validMinimalPayload, unexpected: true }).success, 'strict synthesis schema rejects unknown fields').toBe(true);
  expect(!PresentResultSynthesisModelSchema.safeParse({ ...validMinimalPayload, is_update: true }).success, 'strict synthesis schema rejects repair control on a new render').toBe(true);
});

});
