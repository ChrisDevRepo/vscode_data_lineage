import { z } from 'zod';
import {
  SubmitFindingsBbInputSchema,
  SubmitFindingsCtInputSchema,
  PresentResultModelSchema,
  SubmitFindingsModelSchema,
  PresentResultRepairPatchSchema,
  PresentResultSynthesisModelSchema,
  presentResultSchemaForPhase,
  submitFindingsSchemaForMode,
} from '../../../src/ai/tools/toolSchemas';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';
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

  it("CT carries the shared prune_neighbors — same decision space as BB", () => {
  const parsed = SubmitFindingsCtInputSchema.safeParse({
    focus_node_id: '[dbo].[vSales]',
    sections: [{ angle: 'business', text: 'ok' }],
    summary: 'ok',
    verdict: 'passthrough',
    prune_neighbors: ['[dbo].[vStaging]'],
    column_flow: [],
  });
  // CT is BB plus column tracking, so the CT form accepts every BB field; the topology-safe
  // handling of a given prune target is the shared engine policy.
  expect(parsed.success, 'CT accepts the shared prune_neighbors field').toBe(true);
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

  it("route_requests[].columns is CT-only: BB's dispatched schema itself refuses it", () => {
  // BB's `route_requests[]` shape (`BbRouteRequestSchema`, `toolSchemas.ts`) never advertises the
  // CT-only `columns` decision, so a BB payload naming it fails right here, at the same schema the
  // model is shown — not a call-site strip and not a separate handler-owned pre-Zod refusal layered
  // in front of it. `column_flow` still uses the pre-Zod handler guard (a top-level field, cheap to
  // check before parse); this nested per-route field is narrowed at the schema instead, the same
  // mechanism `submitFindingsSchemaForMode` already uses to lock `sections[].angle`.
  const parsed = SubmitFindingsBbInputSchema.safeParse({
    focus_node_id: '[dbo].[vSales]',
    sections: [{ angle: 'business', text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    route_requests: [{ nodeId: '[dbo].[vStaging]', question: 'trace', columns: ['amount'] }],
  });
  expect(!parsed.success, 'BB refuses the CT-only column channel at the schema, not at a handler call site').toBe(true);
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

  it("CT route_requests[].columns states all three carry decisions, and never an empty array", () => {
  const submit = (columns?: unknown) => SubmitFindingsCtInputSchema.safeParse({
    focus_node_id: '[dbo].[vSales]',
    sections: [{ angle: 'business', text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    column_flow: [],
    route_requests: [{ nodeId: '[dbo].[vStaging]', question: 'trace', ...(columns === undefined ? {} : { columns }) }],
  });
  expect(submit().success, 'not stated — the field is optional').toBe(true);
  expect(submit(['amount']).success, 'stated as these columns').toBe(true);
  expect(submit('none').success, 'stated as none — a row-role-only neighbour').toBe(true);
  // The third state is a word, not an empty list: `[]` and an omitted field would otherwise be one
  // payload with two meanings.
  expect(submit([]).success, 'an empty column list is not a way to say "none"').toBe(false);
  expect(submit('all').success, 'no other word is accepted').toBe(false);
});

  it("both route schema surfaces accept the same route payloads", () => {
  // The strict per-mode schemas and the permissive registered union share one `RouteRequestSchema`,
  // and this pins that they cannot drift apart on the column channel.
  const routes = [
    { nodeId: '[dbo].[vStaging]', question: 'trace' },
    { nodeId: '[dbo].[vStaging]', question: 'trace', columns: ['amount'] },
    { nodeId: '[dbo].[vStaging]', question: 'trace', columns: 'none' },
  ];
  for (const route of routes) {
    const strict = SubmitFindingsCtInputSchema.safeParse({
      focus_node_id: '[dbo].[vSales]',
      sections: [{ angle: 'business', text: 'ok' }],
      summary: 'ok',
      verdict: 'analyze',
      column_flow: [],
      route_requests: [route],
    });
    const registered = SubmitFindingsModelSchema.safeParse({
      focus_node_id: '[dbo].[vSales]',
      sections: [{ angle: 'business', text: 'ok' }],
      summary: 'ok',
      verdict: 'analyze',
      route_requests: [route],
    });
    expect(strict.success, `strict CT accepts ${JSON.stringify(route.columns)}`).toBe(true);
    expect(registered.success, `registered union accepts ${JSON.stringify(route.columns)}`).toBe(true);
  }
  const rejected = { nodeId: '[dbo].[vStaging]', question: 'trace', columns: [] };
  expect(SubmitFindingsCtInputSchema.safeParse({
    focus_node_id: '[dbo].[vSales]', sections: [{ angle: 'business', text: 'ok' }], summary: 'ok',
    verdict: 'analyze', column_flow: [], route_requests: [rejected],
  }).success, 'strict CT refuses the empty list').toBe(false);
  expect(SubmitFindingsModelSchema.safeParse({
    focus_node_id: '[dbo].[vSales]', sections: [{ angle: 'business', text: 'ok' }], summary: 'ok',
    verdict: 'analyze', route_requests: [rejected],
  }).success, 'the registered union refuses it too').toBe(false);
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

  it("Each session is shown exactly one strict form: the BB form without `column_flow`, the CT form with it.", () => {
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

  it("business lock's advertised schema rejects a technical section with a kept-angle hint, not a silent drop", () => {
  // ANGLE-LOCK-SCHEMA: a surplus off-lock angle used to be silently dropped at commit
  // (`filterSectionsForClassification`, removed). It now fails at the per-dispatch schema the
  // model is actually shown, and the rejection message names the kept angle and tells the model
  // to fold the content in rather than submit a second section.
  const bb = submitFindingsSchemaForMode('bb', 'business');
  const technicalOnly = bb.safeParse({
    focus_node_id: '[dbo].[vSales]',
    sections: [{ angle: 'technical', text: 'technical-only content' }],
    summary: 'ok',
    verdict: 'analyze',
  });
  expect(!technicalOnly.success, 'a business lock rejects a technical-angle section').toBe(true);
  const message = technicalOnly.success ? '' : technicalOnly.error.issues.map(i => i.message).join(' | ');
  expect(message.includes('classification=business keeps only angle="business"'), 'the rejection names the kept angle').toBe(true);
  expect(message.toLowerCase().includes('fold'), 'the rejection tells the model to fold the content into the kept section').toBe(true);

  const mixed = bb.safeParse({
    focus_node_id: '[dbo].[vSales]',
    sections: [
      { angle: 'business', text: 'kept' },
      { angle: 'technical', text: 'surplus' },
    ],
    summary: 'ok',
    verdict: 'analyze',
  });
  expect(!mixed.success, 'a business lock rejects a surplus technical section even alongside a valid business one').toBe(true);
});

  it("technical lock's advertised schema mirrors the business lock, symmetrically", () => {
  const ct = submitFindingsSchemaForMode('ct', 'technical');
  const businessOnly = ct.safeParse({
    focus_node_id: '[dbo].[vSales]',
    sections: [{ angle: 'business', text: 'business-only content' }],
    summary: 'ok',
    verdict: 'analyze',
    column_flow: [],
  });
  expect(!businessOnly.success, 'a technical lock rejects a business-angle section').toBe(true);
  const message = businessOnly.success ? '' : businessOnly.error.issues.map(i => i.message).join(' | ');
  expect(message.includes('classification=technical keeps only angle="technical"'), 'the rejection names the kept angle').toBe(true);
});

  it("business lock's advertised schema accepts a business-only submission", () => {
  const bb = submitFindingsSchemaForMode('bb', 'business');
  const parsed = bb.safeParse({
    focus_node_id: '[dbo].[vSales]',
    sections: [{ angle: 'business', text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
  });
  expect(parsed.success, 'business lock accepts a business-only section').toBe(true);
});

  it("both lock's advertised schema accepts both angles, same as the unlocked schema", () => {
  const both = submitFindingsSchemaForMode('bb', 'both');
  expect(both === SubmitFindingsBbInputSchema, "a 'both' lock keeps every angle, so it is the unnarrowed mode schema").toBe(true);
  const parsed = both.safeParse({
    focus_node_id: '[dbo].[vSales]',
    sections: [
      { angle: 'business', text: 'b' },
      { angle: 'technical', text: 't' },
    ],
    summary: 'ok',
    verdict: 'analyze',
  });
  expect(parsed.success, 'both lock accepts both angles').toBe(true);
});

  it("an unlocked (classification-omitted) dispatch keeps the unnarrowed mode schema", () => {
  expect(submitFindingsSchemaForMode('bb') === SubmitFindingsBbInputSchema, 'no classification argument selects the plain BB schema').toBe(true);
  expect(submitFindingsSchemaForMode('ct') === SubmitFindingsCtInputSchema, 'no classification argument selects the plain CT schema').toBe(true);
});

  it("host-advertised CT form carries prune_neighbors but still rejects the repair protocol", () => {
  const ct = submitFindingsSchemaForMode('ct');
  const withPruneNeighbors = ct.safeParse({
    focus_node_id: '[dbo].[vSales]', sections: [], summary: 'ok', verdict: 'analyze',
    column_flow: [], prune_neighbors: ['[dbo].[vStaging]'],
  });
  // Convergence: the advertised CT form accepts the shared BB field — the model can prune or
  // route a neighbour in either mode.
  expect(withPruneNeighbors.success, 'host-advertised CT form accepts the shared prune_neighbors').toBe(true);
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

// T-4 (tooltext sweep): `PresentResultModelSchema.is_update` used to claim it also covered
// "repairing a held draft" — a scenario that is never this schema's own offer (a held-draft
// repair is always the separate `PresentResultRepairPatchSchema`/`presentResultRepairPatchSchemaForFields`
// surface, selected before `PresentResultModelSchema` is ever offered — see `presentResultSchemaForPhase`).
// The misapplied clause is removed rather than reworded; the repair-specific meaning stays owned
// solely by the repair patch schema's own describe.
it("is_update describes only its own schema's meaning, not the other schema's repair scenario", () => {
  const modelDescription = toModelJsonSchema(PresentResultModelSchema) as { properties?: Record<string, { description?: string }> };
  const repairDescription = toModelJsonSchema(PresentResultRepairPatchSchema) as { properties?: Record<string, { description?: string }> };
  const modelIsUpdate = modelDescription.properties?.is_update?.description ?? '';
  const repairIsUpdate = repairDescription.properties?.is_update?.description ?? '';
  expect(modelIsUpdate.includes('repairing a held draft'), 'the non-repair schema no longer claims the repair scenario').toBe(false);
  expect(modelIsUpdate.includes('updating an existing presentation'), 'the non-repair schema keeps its own meaning').toBe(true);
  expect(repairIsUpdate.includes('held draft'), 'the repair patch schema keeps sole ownership of the repair scenario').toBe(true);
});

  it("CT column_flow.writes_to: null is accepted as absence", () => {
  // The engine readers (columnTracer.ts, smBase.ts) already treat writes_to?.node/.col as absent
  // for both null and undefined, so the schema must accept null as absence rather than reject it.
  const parsed = SubmitFindingsCtInputSchema.safeParse({
    focus_node_id: '[dbo].[vSales]',
    sections: [{ angle: 'business', text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    column_flow: [{ out_col: 'amount', writes_to: null, upstream_columns: [] }],
  });
  expect(parsed.success, 'CT column_flow.writes_to: null is accepted as absence').toBe(true);
  if (parsed.success) {
    expect(parsed.data.column_flow?.[0]?.writes_to, 'null writes_to normalizes to undefined (absent), not stored as null').toBe(undefined);
  }
});

  it("CT column_flow.writes_to: \"null\" (string-encoded) is also accepted as absence", () => {
  const parsed = SubmitFindingsCtInputSchema.safeParse({
    focus_node_id: '[dbo].[vSales]',
    sections: [{ angle: 'business', text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    column_flow: [{ out_col: 'amount', writes_to: 'null', upstream_columns: [] }],
  });
  expect(parsed.success, 'string-encoded "null" writes_to is accepted as absence').toBe(true);
  if (parsed.success) {
    expect(parsed.data.column_flow?.[0]?.writes_to, 'string-encoded "null" writes_to normalizes to undefined').toBe(undefined);
  }
});

  it("CT column_flow.writes_to: a genuine object still validates its shape", () => {
  const bad = SubmitFindingsCtInputSchema.safeParse({
    focus_node_id: '[dbo].[vSales]',
    sections: [{ angle: 'business', text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    column_flow: [{ out_col: 'amount', writes_to: { node: '[dbo].[t]' }, upstream_columns: [] }],
  });
  expect(!bad.success, 'a malformed writes_to object (missing col) still rejects — null-passthrough is not a strictness bypass').toBe(true);

  const good = SubmitFindingsCtInputSchema.safeParse({
    focus_node_id: '[dbo].[vSales]',
    sections: [{ angle: 'business', text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    column_flow: [{ out_col: 'amount', writes_to: { node: '[dbo].[t]', col: 'amount' }, upstream_columns: [] }],
  });
  expect(good.success, 'a genuine well-formed writes_to object still validates').toBe(true);
});

  it("writes_to's model-facing JSON schema is unchanged by the null-as-absence preprocess", () => {
  // nullAsAbsent is z.preprocess, transparent to z.toJSONSchema (io: 'input') like its
  // coercedString* siblings — the model never sees a `null` branch it might start emitting on
  // purpose. Assert the property renders as a plain optional object, with no `null` anywhere in
  // its schema shape.
  const jsonSchema = z.toJSONSchema(SubmitFindingsCtInputSchema, { io: 'input', unrepresentable: 'throw' }) as {
    properties?: { column_flow?: { items?: { properties?: { writes_to?: unknown } } } };
  };
  const writesToSchema = jsonSchema.properties?.column_flow?.items?.properties?.writes_to;
  expect(writesToSchema, 'writes_to renders in the model-facing schema').toBeDefined();
  expect(JSON.stringify(writesToSchema).includes('null'), 'writes_to schema carries no null type/branch — the preprocess is fully transparent').toBe(false);
  expect((writesToSchema as { type?: string })?.type, 'writes_to remains a plain object schema').toBe('object');
});

  it("an unknown key inside a column_flow entry is stripped on both surfaces, never rejected", () => {
  // The registered union is what `vscodeModelPort` parses before the handler runs, so a surplus
  // key there ended the turn as `invalid_tool_input` on a payload whose declared fields were all
  // valid. The entry envelope now drops what it does not declare — the same treatment the handler
  // already gives `route_requests[].columns` — and the strict per-mode schema strips identically.
  const entry = {
    out_col: 'amount',
    upstream_columns: [{ node: '[dbo].[vStaging]', col: 'amount' }],
    confidence: 'high',
    transforms: ['pass_through'],
  };
  const registered = SubmitFindingsModelSchema.safeParse({
    focus_node_id: '[dbo].[vSales]',
    sections: [{ angle: 'business', text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    column_flow: [entry],
  });
  expect(registered.success, 'the registered union accepts the surplus key').toBe(true);
  expect(registered.success && Object.keys(registered.data.column_flow![0]).sort().join(','), 'and keeps only the declared fields')
    .toBe('out_col,upstream_columns');
  const strict = SubmitFindingsCtInputSchema.safeParse({
    focus_node_id: '[dbo].[vSales]',
    sections: [{ angle: 'business', text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    column_flow: [{ ...entry, writes_to: { node: '[dbo].[vMart]', col: 'amount', to_col: 'amount' } }],
  });
  expect(strict.success, 'the strict CT schema accepts it too').toBe(true);
  expect(strict.success && Object.keys(strict.data.column_flow[0].writes_to!).sort().join(','), 'writes_to drops its surplus key as well')
    .toBe('col,node');
  // Stripping the envelope never softens the declared fields.
  expect(SubmitFindingsCtInputSchema.safeParse({
    focus_node_id: '[dbo].[vSales]',
    sections: [{ angle: 'business', text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    column_flow: [{ out_col: 7, upstream_columns: [] }],
  }).success, 'a declared field with the wrong type still rejects').toBe(false);
});

  it("the column_flow entry still advertises additionalProperties:false to the model", () => {
  // The permission for the lenient parse is that the advertised contract does not move: the model
  // is still told not to send surplus keys, so this must never become a licence to invent fields.
  const jsonSchema = z.toJSONSchema(SubmitFindingsModelSchema, { io: 'input', unrepresentable: 'throw' }) as {
    properties?: { column_flow?: { items?: Record<string, unknown> & { properties?: { writes_to?: Record<string, unknown> } } } };
  };
  const entrySchema = jsonSchema.properties?.column_flow?.items;
  expect(entrySchema?.additionalProperties, 'the entry keeps additionalProperties:false').toBe(false);
  expect(entrySchema?.properties?.writes_to?.additionalProperties, 'writes_to keeps additionalProperties:false').toBe(false);
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

  // T-4 (tooltext sweep): the strict per-mode schemas and the permissive registered union used to
  // restate the same `badge_label` fact with different wording ("are authored by" vs "come from").
  // Both now describe from the shared `BADGE_LABEL_DESCRIPTION` constant, the same pattern already
  // used for `PRUNE_NEIGHBORS_DESCRIPTION` and `ROUTE_REQUESTS_DESCRIPTION`.
  it("badge_label advertises one describe string across every submit_findings surface", () => {
    const describeOf = (schema: z.ZodType) => {
      const projected = toModelJsonSchema(schema) as { properties?: Record<string, { description?: string }> };
      return projected.properties?.badge_label?.description ?? '';
    };
    const descriptions = [SubmitFindingsBbInputSchema, SubmitFindingsCtInputSchema, SubmitFindingsModelSchema].map(describeOf);
    expect(descriptions.every(d => d.length > 0), 'every surface actually carries a badge_label description').toBe(true);
    expect(new Set(descriptions).size, 'BB, CT, and the registered union describe badge_label identically').toBe(1);
    expect(descriptions[0], 'the shared describe string states the 50-char cap').toContain('Maximum 50 characters');
  });

  it('CT verdict description carries no BB-only "business/technical logic" phrase', () => {
    const projected = toModelJsonSchema(SubmitFindingsCtInputSchema) as { properties?: Record<string, { description?: string }> };
    expect(projected.properties?.verdict?.description ?? '').not.toContain('business/technical logic');
  });

  it('BB verdict description carries no CT-only "terminal source" phrase', () => {
    const projected = toModelJsonSchema(SubmitFindingsBbInputSchema) as { properties?: Record<string, { description?: string }> };
    expect(projected.properties?.verdict?.description ?? '').not.toContain('terminal source');
  });

});
