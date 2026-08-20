import { z } from 'zod';
import {
  PresentResultModelSchema,
  PresentResultRepairPatchSchema,
  PresentResultSynthesisModelSchema,
  presentResultRepairPatchSchemaForFields,
} from '../../../src/ai/tools/toolSchemas';
import { mergePresentResultRepairPatch } from '../../../src/ai/tools/presentResult';
import { assert, assertEq } from '../helpers/testUtils';
import { describe, it } from 'vitest';

describe("present_result repair-patch parity", () => {
  const GRAPH_EDIT_OR_CONTROL = new Set(['prune_node_ids', 'add_node_ids', 'is_update']);
  const fullKeys = Object.keys(PresentResultModelSchema.shape).filter((k) => !GRAPH_EDIT_OR_CONTROL.has(k));
  const patchKeys = new Set(Object.keys(PresentResultRepairPatchSchema.shape));
  it("repair-patch schema has no missing presentation field (drift)", () => {
    for (const key of fullKeys) {
      assert(patchKeys.has(key), `repair-patch schema is missing presentation field "${key}" — drift`);
    }
  });

  it("repair-patch is_update carries a repair-specific declared-default description (not the canonical one)", () => {
  const fullJsonSchema = z.toJSONSchema(PresentResultModelSchema) as { properties?: Record<string, { description?: string }> };
  const patchJsonSchema = z.toJSONSchema(PresentResultRepairPatchSchema) as { properties?: Record<string, { description?: string }> };
  // is_update intentionally diverges: in the repair patch it is an engine-declared default
  // (backfilled from the held-draft context), not a value the model must echo — so it carries a
  // repair-specific description rather than the canonical one.
  assert(
    (patchJsonSchema.properties?.is_update?.description ?? '')
      !== (fullJsonSchema.properties?.is_update?.description ?? ''),
    'repair-patch is_update carries a repair-specific declared-default description (not the canonical one)',
  );
});

  it("repair patch must not accept prune_node_ids (graph edit)", () => { assert(!patchKeys.has('prune_node_ids'), 'repair patch must not accept prune_node_ids (graph edit)'); });

  it("repair patch must not accept add_node_ids (graph edit)", () => { assert(!patchKeys.has('add_node_ids'), 'repair patch must not accept add_node_ids (graph edit)'); });

  it("layout_direction specifically: a repair retry that echoes it back must not hard-reject.", () => {
  const parsed = PresentResultRepairPatchSchema.safeParse({
    is_update: true,
    layout_direction: 'LR',
    sections: [{ label: 'Overview', text: 'Corrected text.' }],
  });
  assert(parsed.success, 'repair patch accepts layout_direction');
});

  it("a minimal is_update-only patch is valid", () => { assert(PresentResultRepairPatchSchema.safeParse({ is_update: true }).success, 'a minimal is_update-only patch is valid'); });

  it("a patch without is_update is valid (engine declares the default from the held-draft context)", () => { assert(PresentResultRepairPatchSchema.safeParse({ summary: 'x' }).success, 'a patch without is_update is valid (engine declares the default from the held-draft context)'); });

  it("strict: unknown/forbidden key rejects", () => { assert(!PresentResultRepairPatchSchema.safeParse({ is_update: true, add_node_ids: ['n'] }).success, 'strict: unknown/forbidden key rejects'); });

  it("Merge carries a patched layout_direction into the held draft.", () => {
  const draft = { name: 'n', summary: 's', layout_direction: 'TB', highlight_groups: [] } as never;
  const merged = mergePresentResultRepairPatch(draft, { is_update: true, layout_direction: 'LR' }, ['layout_direction']);
  assertEq(merged.layout_direction, 'LR', 'merge carries a patched layout_direction into the held draft');
});

  it("field-scoped schema accepts the authorized field", () => {
  const sectionsOnly = presentResultRepairPatchSchemaForFields(['sections']);
  assert(sectionsOnly.safeParse({ sections: [{ label: 'Overview', text: 'Corrected.' }] }).success, 'field-scoped schema accepts the authorized field');
  assert(!sectionsOnly.safeParse({ sections: [], summary: 'unauthorized' }).success, 'field-scoped schema rejects an additional known presentation field');
  const draft = { name: 'n', summary: 'original', sections: [], highlight_groups: [], notes: [] } as never;
  let threw = false;
  try {
    mergePresentResultRepairPatch(draft, { summary: 'unauthorized' }, ['sections']);
  } catch {
    threw = true;
  }
  assert(threw, 'merge defensively rejects unauthorized fields instead of silently ignoring them');
});

  it("excludes graph-edit/control fields and preserves full-render requiredness.", () => {
  const synthKeys = new Set(Object.keys(PresentResultSynthesisModelSchema.shape));
  for (const key of fullKeys) {
    assert(synthKeys.has(key), `synthesis schema is missing presentation field "${key}" — drift`);
  }
  // Graph-edit fields must NOT leak into the synthesis schema (prune/add are Completed-Phase only).
  assert(!synthKeys.has('prune_node_ids'), 'synthesis schema must not accept prune_node_ids (graph edit)');
  assert(!synthKeys.has('add_node_ids'), 'synthesis schema must not accept add_node_ids (graph edit)');
  // layout_direction specifically: a synthesis render that sets it must parse (the regression guarded).
  const parsed = PresentResultSynthesisModelSchema.safeParse({
    name: 'n', summary: 's', layout_direction: 'LR',
    highlight_groups: [{ label: 'Source', color: 'source', node_ids: ['a'] }],
    sections: [{ label: 'Overview', text: 'x' }],
  });
  assert(parsed.success, 'synthesis schema accepts layout_direction');
  assert(!synthKeys.has('is_update'), 'synthesis schema must not advertise held-repair/update control');
});

  it("are required, while unknown fields remain rejected.", () => {
  const validMinimalPayload = {
    name: 'n', summary: 's',
    highlight_groups: [{ label: 'Source', color: 'source' as const, node_ids: ['a'] }],
    sections: [{ label: 'Overview', text: 'x' }],
  };
  assert(PresentResultSynthesisModelSchema.safeParse(validMinimalPayload).success, 'sanity: the minimal payload itself is valid');
  assert(
    !PresentResultSynthesisModelSchema.safeParse({ ...validMinimalPayload, highlight_groups: [] }).success,
    'strict synthesis schema enforces highlight_groups min(1)',
  );
  assert(!PresentResultSynthesisModelSchema.safeParse({ ...validMinimalPayload, name: undefined }).success, 'strict synthesis schema requires name');
  assert(!PresentResultSynthesisModelSchema.safeParse({ ...validMinimalPayload, summary: undefined }).success, 'strict synthesis schema requires summary');
  assert(!PresentResultSynthesisModelSchema.safeParse({ ...validMinimalPayload, highlight_groups: undefined }).success, 'strict synthesis schema requires highlight_groups');
  assert(!PresentResultSynthesisModelSchema.safeParse({ ...validMinimalPayload, unexpected: true }).success, 'strict synthesis schema rejects unknown fields');
  assert(!PresentResultSynthesisModelSchema.safeParse({ ...validMinimalPayload, is_update: true }).success, 'strict synthesis schema rejects repair control on a new render');
});

});
