import {
  SubmitFindingsBbInputSchema,
  SubmitFindingsCtInputSchema,
  PresentResultModelSchema,
  PresentResultRepairPatchSchema,
  PresentResultSynthesisModelSchema,
  presentResultSchemaForPhase,
  submitFindingsSchemaForMode,
} from '../../../src/ai/tools/toolSchemas';
import { describe, expect, it } from 'vitest';

describe("Submit Findings Schema", () => {
  it("BB accepts self-prune verdict (analyze|passthrough|prune)", () => {
  // The schema admits the prune verdict; the engine decides whether the current focus may be removed.
  const parsed = SubmitFindingsBbInputSchema.safeParse({
    focus_node_id: '[dbo].[vSales]',
    sections: [{ angle: 'business', text: 'ok' }],
    summary: 'ok',
    verdict: 'prune',
  });
  expect(parsed.success, 'BB accepts self-prune verdict (analyze|passthrough|prune)').toBe(true);
});

  it("BB accepts prune_neighbors with an analyze verdict", () => {
  // prune_neighbors is structurally valid alongside an analyze verdict; current-hop eligibility is engine-owned.
  const parsed = SubmitFindingsBbInputSchema.safeParse({
    focus_node_id: '[dbo].[vSales]',
    sections: [{ angle: 'business', text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    prune_neighbors: ['[dbo].[vStaging]'],
  });
  expect(parsed.success, 'BB accepts prune_neighbors with an analyze verdict').toBe(true);
});

  it("BB rejects CT-only column_flow field", () => {
  const parsed = SubmitFindingsBbInputSchema.safeParse({
    focus_node_id: '[dbo].[vSales]',
    sections: [{ angle: 'business', text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    column_flow: [],
  });
  expect(!parsed.success, 'BB rejects CT-only column_flow field').toBe(true);
});

  it("BB rejects removed note_caption field", () => {
  const parsed = SubmitFindingsBbInputSchema.safeParse({
    focus_node_id: '[dbo].[vSales]',
    sections: [{ angle: 'business', text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    note_caption: 'stale preview caption',
  });
  expect(!parsed.success, 'BB rejects removed note_caption field').toBe(true);
});

  it("CT accepts explicit column_flow (including empty array)", () => {
  const parsed = SubmitFindingsCtInputSchema.safeParse({
    focus_node_id: '[dbo].[vSales]',
    sections: [{ angle: 'business', text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    column_flow: [],
  });
  expect(parsed.success, 'CT accepts explicit column_flow (including empty array)').toBe(true);
});

  it("CT accepts self-prune verdict (analyze|passthrough|prune)", () => {
  // CT also accepts self-prune — verdict=prune is a silent engine auto-prune (focus has no column flow).
  const parsed = SubmitFindingsCtInputSchema.safeParse({
    focus_node_id: '[dbo].[vSales]',
    sections: [{ angle: 'business', text: 'ok' }],
    summary: 'ok',
    verdict: 'prune',
    column_flow: [],
  });
  expect(parsed.success, 'CT accepts self-prune verdict (analyze|passthrough|prune)').toBe(true);
});

  it("CT rejects BB-only prune_neighbors", () => {
  const parsed = SubmitFindingsCtInputSchema.safeParse({
    focus_node_id: '[dbo].[vSales]',
    sections: [{ angle: 'business', text: 'ok' }],
    summary: 'ok',
    verdict: 'passthrough',
    prune_neighbors: ['[dbo].[vStaging]'],
    column_flow: [],
  });
  expect(!parsed.success, 'CT rejects BB-only prune_neighbors').toBe(true);
});

  it("CT requires column_flow field", () => {
  const parsed = SubmitFindingsCtInputSchema.safeParse({
    focus_node_id: '[dbo].[vSales]',
    sections: [{ angle: 'business', text: 'ok' }],
    summary: 'ok',
    verdict: 'passthrough',
  });
  expect(!parsed.success, 'CT requires column_flow field').toBe(true);
});

  it("route_requests[].columns is no longer part of CT; column spine lives in column_flow", () => {
  const parsed = SubmitFindingsBbInputSchema.safeParse({
    focus_node_id: '[dbo].[vSales]',
    sections: [{ angle: 'business', text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    route_requests: [{ nodeId: '[dbo].[vStaging]', question: 'trace', columns: ['amount'] }],
  });
  expect(!parsed.success, 'BB rejects route_requests[].columns').toBe(true);
});

  it("BB accepts route_requests without columns", () => {
  const parsed = SubmitFindingsBbInputSchema.safeParse({
    focus_node_id: '[dbo].[vSales]',
    sections: [{ angle: 'business', text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    route_requests: [{ nodeId: '[dbo].[vStaging]', question: 'trace' }],
  });
  expect(parsed.success, 'BB accepts route_requests without columns').toBe(true);
});

  it("CT rejects route_requests[].columns", () => {
  const parsed = SubmitFindingsCtInputSchema.safeParse({
    focus_node_id: '[dbo].[vSales]',
    sections: [{ angle: 'business', text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    column_flow: [],
    route_requests: [{ nodeId: '[dbo].[vStaging]', question: 'trace', columns: ['amount'] }],
  });
  expect(!parsed.success, 'CT rejects route_requests[].columns').toBe(true);
});

  it("CT accepts upstream_columns in column_flow with plain route_requests", () => {
  const parsed = SubmitFindingsCtInputSchema.safeParse({
    focus_node_id: '[dbo].[vSales]',
    sections: [{ angle: 'business', text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    column_flow: [{ out_col: 'amount', upstream_columns: [{ node: '[dbo].[vStaging]', col: 'amount' }] }],
    route_requests: [{ nodeId: '[dbo].[vStaging]', question: 'trace amount' }],
  });
  expect(parsed.success, 'CT accepts upstream_columns in column_flow with plain route_requests').toBe(true);
});

  it("In a BB session the model must never be shown the `column_flow` box; in CT never `prune_neighbors`.", () => {
  expect(submitFindingsSchemaForMode('bb') === SubmitFindingsBbInputSchema, 'selector returns the single strict BB schema').toBe(true);
  expect(submitFindingsSchemaForMode('ct') === SubmitFindingsCtInputSchema, 'selector returns the single strict CT schema').toBe(true);
});

  it("host-advertised BB form rejects column_flow (BUG-2)", () => {
  // The exact BUG-2 payload: a BB session, model emits column_flow. The advertised BB form rejects it
  // (no rejection loop), and a clean BB call passes.
  const bb = submitFindingsSchemaForMode('bb');
  const withColumnFlow = bb.safeParse({
    focus_node_id: '[dbo].[vSales]', sections: [], summary: 'ok', verdict: 'analyze', column_flow: [],
  });
  expect(!withColumnFlow.success, 'host-advertised BB form rejects column_flow (BUG-2)').toBe(true);
  const repairBb = bb.safeParse({ repair: true, focus_node_id: '[dbo].[vSales]', prune_neighbors: ['[dbo].[vStaging]'] });
  expect(!repairBb.success, 'host-advertised BB form rejects the unapproved repair protocol').toBe(true);
  expect(bb.safeParse({
    focus_node_id: '[dbo].[vSales]', sections: [{ angle: 'business', text: 'ok' }], summary: 'ok', verdict: 'analyze',
  }).success, 'host-advertised BB form accepts a complete full submission').toBe(true);
  expect(!bb.safeParse({ focus_node_id: '[dbo].[vSales]' }).success, 'host-advertised BB form rejects an incomplete non-repair submission').toBe(true);
});

  it("host-advertised CT form rejects prune_neighbors", () => {
  const ct = submitFindingsSchemaForMode('ct');
  const withPruneNeighbors = ct.safeParse({
    focus_node_id: '[dbo].[vSales]', sections: [], summary: 'ok', verdict: 'analyze',
    column_flow: [], prune_neighbors: ['[dbo].[vStaging]'],
  });
  expect(!withPruneNeighbors.success, 'host-advertised CT form rejects prune_neighbors').toBe(true);
  const repairCt = ct.safeParse({ repair: true, focus_node_id: '[dbo].[vSales]', column_flow: [] });
  expect(!repairCt.success, 'host-advertised CT form rejects the unapproved repair protocol').toBe(true);
});

  it("Strict mode boundary without an independent patch protocol.", () => {
  const base = {
    focus_node_id: '[dbo].[vSales]',
    sections: [{ angle: 'business' as const, text: 'grounded' }],
    summary: 'summary',
    verdict: 'analyze' as const,
  };
  expect(!SubmitFindingsBbInputSchema.safeParse({ ...base, focus_node_id: null }).success, 'BB rejects null focus identity').toBe(true);
  expect(!SubmitFindingsBbInputSchema.safeParse({ ...base, route_requests: [{ nodeId: 'n', question: 'trace', extra: true }] }).success, 'BB rejects unknown nested route fields').toBe(true);
  expect(!SubmitFindingsBbInputSchema.safeParse({ ...base, repair: true }).success, 'BB rejects repair metadata on a complete finding').toBe(true);
  expect(!SubmitFindingsCtInputSchema.safeParse({ ...base, column_flow: [], repair: true }).success, 'CT rejects repair metadata on a complete finding').toBe(true);
});

  it("Host-path synthesis lock: graph-edit fields are not advertised during initial synthesis.", () => {
  const synthesis = presentResultSchemaForPhase('synthesis');
  expect(synthesis === PresentResultSynthesisModelSchema, 'selector returns the strict new-render synthesis schema').toBe(true);
  expect(presentResultSchemaForPhase('completed') === PresentResultModelSchema, 'completed keeps the full present_result schema').toBe(true);

  const withGraphEdit = synthesis.safeParse({
    name: 'Result',
    summary: 'ok',
    highlight_groups: [{ label: 'Target', color: 'target', node_ids: ['[dbo].[fact]'] }],
    sections: [{ label: 'Output', text: 'ok', node_ids: ['[dbo].[fact]'] }],
    add_node_ids: ['[dbo].[extra]'],
  });
  expect(!withGraphEdit.success, 'synthesis schema rejects add_node_ids').toBe(true);

  const cleanSynthesis = synthesis.safeParse({
    name: 'Result',
    summary: 'ok',
    highlight_groups: [{ label: 'Target', color: 'target', node_ids: ['[dbo].[fact]'] }],
    sections: [{ label: 'Output', text: 'ok', node_ids: ['[dbo].[fact]'] }],
  });
  expect(cleanSynthesis.success, 'synthesis schema accepts text/highlight/section payload').toBe(true);

  const repairPatch = synthesis.safeParse({
    is_update: true,
    notes: [{ node_id: '[dbo].[fact]', text: 'Explains an already-highlighted node.' }],
  });
  expect(!repairPatch.success, 'initial synthesis schema does not advertise partial held-draft repair patches').toBe(true);

  const repairPatchWithUnknown = PresentResultRepairPatchSchema.safeParse({
    is_update: true,
    notes: [{ node_id: '[dbo].[fact]', text: 'Explains an already-highlighted node.' }],
    add_node_ids: ['[dbo].[extra]'],
  });
  expect(!repairPatchWithUnknown.success, 'repair patch schema rejects unknown graph-edit fields').toBe(true);

  const updateShapedDuringSynthesis = synthesis.safeParse({
    is_update: true,
    name: 'Result',
    summary: 'ok',
    highlight_groups: [{ label: 'Target', color: 'target', node_ids: ['[dbo].[fact]'] }],
    sections: [{ label: 'Output', text: 'ok', node_ids: ['[dbo].[fact]'] }],
  });
  expect(!updateShapedDuringSynthesis.success, 'initial synthesis schema does not advertise is_update on a full new render').toBe(true);

  const authorizedRepair = presentResultSchemaForPhase('synthesis', ['notes']);
  expect(authorizedRepair !== PresentResultRepairPatchSchema, 'held-draft synthesis selects a field-scoped strict repair patch schema').toBe(true);
  expect(authorizedRepair.safeParse({ is_update: true, notes: [{ node_id: '[dbo].[fact]', text: 'Corrected note.' }] }).success, 'authorized repair accepts a strict patch').toBe(true);
  expect(!authorizedRepair.safeParse({ summary: 'unauthorized' }).success, 'authorized repair rejects a known but unauthorized presentation field').toBe(true);
  expect(!authorizedRepair.safeParse({ is_update: true, unexpected: true }).success, 'authorized repair remains strict').toBe(true);

  const completed = presentResultSchemaForPhase('completed');
  const completedEdit = completed.safeParse({
    name: 'Result',
    summary: 'ok',
    highlight_groups: [{ label: 'Target', color: 'target', node_ids: ['[dbo].[fact]'] }],
    sections: [{ label: 'Output', text: 'ok', node_ids: ['[dbo].[fact]'] }],
    add_node_ids: ['[dbo].[extra]'],
  });
  expect(completedEdit.success, 'completed schema still accepts add_node_ids for follow-up edits').toBe(true);
});

  it("empty badge_label rejects", () => {
  // Blank labels are invalid input; the boundary never silently discards them.
  const base = {
    focus_node_id: '[dbo].[vSales]',
    sections: [{ angle: 'business', text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
  };
  const emptyLabel = SubmitFindingsBbInputSchema.safeParse({ ...base, badge_label: '' });
  expect(!emptyLabel.success, 'empty badge_label rejects').toBe(true);
  expect(!SubmitFindingsBbInputSchema.safeParse({ ...base, badge_label: '   ' }).success, 'whitespace-only badge_label rejects').toBe(true);
  const namedLabel = SubmitFindingsBbInputSchema.safeParse({ ...base, badge_label: 'Price source' });
  expect(namedLabel.success && namedLabel.data.badge_label === 'Price source', 'non-empty badge_label passes through verbatim').toBe(true);
});

});
