import { executeSubmitFindings } from '../../../src/ai/tools/handlers/submitFindings';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { ToolServices } from '../../../src/ai/tools/handlers/toolServices';
import { makeGraph } from '../helpers/testUtils';
import { COLUMN_FLOW_NOTE_MAX, SUBMIT_FINDINGS_BADGE_LABEL_MAX } from '../../../src/ai/tools/toolSchemas';
import { describe, expect, it } from 'vitest';

describe("Submit Findings Handler", () => {
  const nodes = [
    { id: 'origin', schema: 'dbo', name: 'Origin', type: 'view' },
    { id: 'a', schema: 'dbo', name: 'A', type: 'view' },
    { id: 'b', schema: 'dbo', name: 'B', type: 'view' },
  ] as any;
  const model = {
    nodes,
    edges: [
      { source: 'origin', target: 'a', type: 'SELECT' },
      { source: 'origin', target: 'b', type: 'SELECT' },
    ],
    schemas: ['dbo'],
    dbPlatform: 'SQL Server',
  } as any;
  function setup(classification: 'business' | 'technical' | 'both' = 'business', archived: ReadonlyArray<'business' | 'technical'> = []) {
    const graph = makeGraph(nodes, [['origin', 'a'], ['origin', 'b']]);
    const engine = new NavigationEngine(model, graph, () => {}, {});
    engine.init({ origin: 'origin', question: 'trace', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 1 } });
    engine.getHopContext();
    let returned: Record<string, unknown> = {};
    const session = {
      stateMachine: engine,
      classification,
      memory: { getUserQuestion: () => 'trace', getArchivedAngles: () => new Set(archived) },
      storeSmResult: () => {},
    };
    const services = {
      getSession: () => session,
      getPanel: () => undefined,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      turnEpoch: () => 1,
      requireModel: () => model,
      requireGraph: () => graph,
      logAndReturn: (_tool: string, data: Record<string, unknown>) => {
        returned = data;
        return data;
      },
      buildActiveFilter: () => ({}),
      toolError: (_tool: string, error: unknown) => ({ error: 'internal_error', detail: String(error) }),
    } as unknown as ToolServices;
    return { engine, services, result: () => returned };
  }
  function setupCt() {
    const ctNodes = [
      { id: 'origin', schema: 'dbo', name: 'Origin', type: 'view', columns: [{ name: 'amount', type: 'int', nullable: 'NOT NULL', extra: '' }] },
      { id: 'base_table', schema: 'dbo', name: 'BaseTable', type: 'table', columns: [{ name: 'raw_amount', type: 'int', nullable: 'NOT NULL', extra: '' }] },
    ] as any;
    const ctModel = {
      nodes: ctNodes,
      edges: [{ source: 'base_table', target: 'origin', type: 'SELECT' }],
      schemas: ['dbo'],
      dbPlatform: 'SQL Server',
    } as any;
    const graph = makeGraph(ctNodes, [['base_table', 'origin']]);
    const engine = new NavigationEngine(ctModel, graph, () => {}, {});
    engine.init({ origin: 'origin', question: 'trace amount', direction: 'upstream', analysisMode: 'ct', targetColumns: ['amount'] });
    engine.getHopContext();
    let returned: Record<string, unknown> = {};
    const session = {
      stateMachine: engine,
      classification: 'business',
      memory: { getUserQuestion: () => 'trace amount', getArchivedAngles: () => new Set() },
      storeSmResult: () => {},
    };
    const services = {
      getSession: () => session,
      getPanel: () => undefined,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      turnEpoch: () => 1,
      requireModel: () => ctModel,
      requireGraph: () => graph,
      logAndReturn: (_tool: string, data: Record<string, unknown>) => {
        returned = data;
        return data;
      },
      buildActiveFilter: () => ({}),
      toolError: (_tool: string, error: unknown) => ({ error: 'internal_error', detail: String(error) }),
    } as unknown as ToolServices;
    return { engine, services, result: () => returned };
  }
  it("complete full BB finding passes without repair metadata", () => {
  const { engine, services, result } = setup();
  const raw = {
    focus_node_id: 'ORIGIN',
    sections: [{ angle: 'business', text: 'Origin dispatches both paths.' }],
    summary: 'Origin dispatches both paths.',
    verdict: 'analyze',
    route_requests: [
      { nodeId: 'A', question: 'Trace A.' },
      { nodeId: 'B', question: 'Trace B.' },
    ],
  };
  executeSubmitFindings(raw, services);
  const accepted = result() as { error?: string };
  expect(accepted.error === undefined, 'complete full BB finding passes without repair metadata').toBe(true);
  expect(engine.toJSON().memory.detailSlots.origin !== undefined, 'accepted full finding commits authored detail').toBe(true);
  expect(raw.focus_node_id, 'normalization does not mutate the raw focus identity').toBe('ORIGIN');
  expect(raw.route_requests[0].nodeId, 'normalization does not mutate raw route identities').toBe('A');
});

  // ANGLE-LOCK-SCHEMA: the handler must validate with the SAME mode-and-classification-locked
  // schema `instructionPlan.ts` advertised (`submitFindingsSchemaForMode(mode, sess.classification)`),
  // not just the mode-only base schema — otherwise a provider that ignores the advertised schema
  // could still submit an off-lock angle, which would pass Zod and (with the old silent-drop
  // filter removed) commit off-classification content into the archive undetected.
  it("a business lock rejects a technical section through the real handler, with the kept-angle hint, and commits nothing", () => {
  const { engine, services, result } = setup('business');
  const before = engine.toJSON();
  executeSubmitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'technical', text: 'Off-lock technical content that must not be silently dropped.' }],
    summary: 'Origin dispatches both paths.',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'a', question: 'Trace A.' }, { nodeId: 'b', question: 'Trace B.' }],
  }, services);
  const rejected = result() as { error?: string; hint?: string };
  expect(rejected.error, 'a business lock rejects a technical section through the same schema the model was offered').toBe('invalid_input');
  expect(rejected.hint, 'the rejection names the kept angle').toContain('classification=business keeps only angle="business"');
  expect(rejected.hint?.toLowerCase(), 'the rejection tells the model to fold the content into the kept section').toContain('fold');
  const after = engine.toJSON();
  expect(Object.keys(after.memory.detailSlots).length, 'the off-lock section commits nothing — it never reached the engine').toBe(Object.keys(before.memory.detailSlots).length);
  expect(after.agenda.length, 'no agenda mutation from the rejected submission').toBe(before.agenda.length);
});

  // The actual leak vector `filterSectionsForClassification`'s removal opened: a submission
  // carrying BOTH the required business section AND a surplus technical one satisfies
  // `validateSectionsAgainstClassification` (the required angle is present), so only the
  // per-dispatch schema narrowing stands between this payload and a committed technical leak.
  // Reproduces the defect the reviewer found: validating with the mode-only base schema instead
  // of `submitFindingsSchemaForMode(mode, sess.classification)` let this exact payload commit both
  // sections, with the off-lock one going straight into the archive.
  it("a business lock rejects a mixed business+technical submission — the surplus angle never commits", () => {
  const { engine, services, result } = setup('business');
  const before = engine.toJSON();
  executeSubmitFindings({
    focus_node_id: 'origin',
    sections: [
      { angle: 'business', text: 'Origin dispatches both paths (business angle).' },
      { angle: 'technical', text: 'Off-lock technical content that must not leak in.' },
    ],
    summary: 'Origin dispatches both paths.',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'a', question: 'Trace A.' }, { nodeId: 'b', question: 'Trace B.' }],
  }, services);
  const rejected = result() as { error?: string; hint?: string };
  expect(rejected.error, 'the required business section present does not excuse the surplus technical one').toBe('invalid_input');
  expect(rejected.hint, 'the rejection names the kept angle').toContain('classification=business keeps only angle="business"');
  const after = engine.toJSON();
  expect(Object.keys(after.memory.detailSlots).length, 'nothing commits — not even the valid business section — until the model resubmits clean').toBe(Object.keys(before.memory.detailSlots).length);
});

  // m57-close-azure-azure-foundry run-T8 host.log:151-187: a both-lock reopen sent one section
  // with a stray key plus no technical section. The Zod `.strict()` reject named only the key,
  // so the resend (business only, key dropped) then hit a SECOND rejection for the angle the
  // first response never mentioned — two rejections for one root-cause submission. The handler
  // now folds the angle-lock check into the same Zod-failure pass so both problems are named once.
  it("a both-lock submission with a stray section key and a missing angle names both problems in one rejection", () => {
  const { services, result } = setup('both');
  executeSubmitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business', text: 'Reopen business note.', '#': 'temporary' }],
    summary: 'Reopen business note.',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'a', question: 'Trace A.' }, { nodeId: 'b', question: 'Trace B.' }],
  }, services);
  const rejected = result() as { error?: string; hint?: string };
  expect(rejected.error, 'the strict-schema reject keeps its established code').toBe('invalid_input');
  expect(rejected.hint ?? '', 'the hint still names the unrecognized key').toContain('Unrecognized key');
  expect(rejected.hint ?? '', 'the SAME rejection also names the missing angle, instead of a second round-trip').toContain('missing angle="technical"');
});

  it("a reopen's stray-key rejection does not claim an angle the earlier visit already archived", () => {
  const { services, result } = setup('both', ['technical']);
  executeSubmitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business', text: 'Reopen business note.', '#': 'temporary' }],
    summary: 'Reopen business note.',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'a', question: 'Trace A.' }, { nodeId: 'b', question: 'Trace B.' }],
  }, services);
  const rejected = result() as { error?: string; hint?: string };
  expect(rejected.hint ?? '', 'the hint names the unrecognized key').toContain('Unrecognized key');
  expect(rejected.hint ?? '', 'an archived angle is never named as missing').not.toContain('missing angle');
});

  it("a both lock accepts a submission carrying both angles through the real handler", () => {
  const { engine, services, result } = setup('both');
  executeSubmitFindings({
    focus_node_id: 'origin',
    sections: [
      { angle: 'business', text: 'Origin dispatches both paths (business angle).' },
      { angle: 'technical', text: 'Origin dispatches both paths (technical angle).' },
    ],
    summary: 'Origin dispatches both paths.',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'a', question: 'Trace A.' }, { nodeId: 'b', question: 'Trace B.' }],
  }, services);
  const accepted = result() as { error?: string };
  expect(accepted.error, 'a both lock accepts a submission carrying both angles').toBeUndefined();
  const slot = engine.toJSON().memory.detailSlots.origin as { sections?: Array<{ angle: string }> };
  expect(slot?.sections?.map(s => s.angle).sort(), 'both authored sections are committed').toEqual(['business', 'technical']);
});

  // `badge_label` and `column_flow[].upstream_columns[].note` carry their cap on the model-facing
  // schema only. A Zod reject at the boundary would fail the hop with a field path and no held
  // draft, so a label two words too long cost a verbatim resend of the authored sections and
  // summary. The engine enforces both ahead of every mutation and holds the draft instead.
  it("an over-long badge_label rejects before any mutation and holds the authored prose", () => {
  const { engine, services, result } = setup();
  const before = engine.toJSON();
  executeSubmitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business', text: 'Origin dispatches both paths.' }],
    summary: 'Origin dispatches both paths.',
    verdict: 'analyze',
    badge_label: 'B'.repeat(SUBMIT_FINDINGS_BADGE_LABEL_MAX + 1),
    route_requests: [{ nodeId: 'a', question: 'Trace A.' }, { nodeId: 'b', question: 'Trace B.' }],
  }, services);

  const rejected = result() as { error?: string; hint?: string; detail?: Array<{ path?: string; chars?: number; limit?: number }> };
  expect(rejected.error, 'an over-long badge_label rejects on its own code').toBe('field_length_exceeded');
  expect(rejected.hint, 'the rejection states the measured length against the limit')
    .toContain(`${SUBMIT_FINDINGS_BADGE_LABEL_MAX + 1} chars, limit ${SUBMIT_FINDINGS_BADGE_LABEL_MAX}`);
  expect(rejected.detail?.[0]?.path, 'the rejection names the exact field path').toBe('badge_label');
  expect(rejected.hint, 'the retry is told it may omit sections to keep the held prose').toMatch(/sections: \[\]/);

  const after = engine.toJSON();
  expect(Object.keys(after.memory.detailSlots).length, 'no archive mutation').toBe(Object.keys(before.memory.detailSlots).length);
  expect(after.agenda.length, 'no agenda mutation').toBe(before.agenda.length);
  expect(after.scopeNodeIds.length, 'no scope mutation').toBe(before.scopeNodeIds.length);

  // The retry carries only the corrected structured fields; `sections: []` keeps the held prose.
  executeSubmitFindings({
    focus_node_id: 'origin',
    sections: [],
    summary: '',
    verdict: 'analyze',
    badge_label: 'Dispatch',
    route_requests: [{ nodeId: 'a', question: 'Trace A.' }, { nodeId: 'b', question: 'Trace B.' }],
  }, services);

  const accepted = result() as { error?: string };
  expect(accepted.error, 'the shortened retry commits').toBeUndefined();
  const slot = engine.toJSON().memory.detailSlots.origin as { sections?: Array<{ text: string }>; summary?: string };
  expect(slot?.summary, 'the held summary is restored').toBe('Origin dispatches both paths.');
  expect(slot?.sections?.[0]?.text, 'the held section prose is restored').toBe('Origin dispatches both paths.');
});

  it("an over-long column_flow note rejects before any mutation and names its entry path", () => {
  const { engine, services, result } = setupCt();
  const before = engine.toJSON();
  executeSubmitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business', text: 'Origin reads amount from base_table.' }],
    summary: 'Origin reads amount from base_table.',
    verdict: 'analyze',
    column_flow: [{
      out_col: 'amount',
      upstream_columns: [{ node: 'base_table', col: 'raw_amount', note: 'N'.repeat(COLUMN_FLOW_NOTE_MAX + 1) }],
    }],
    route_requests: engine.requiredNeighborIds('origin').map(id => ({ nodeId: id, question: 'what does this contribute?', columns: ['amount'] })),
  }, services);

  const rejected = result() as { error?: string; hint?: string; detail?: Array<{ path?: string }> };
  expect(rejected.error, 'an over-long note rejects on its own code').toBe('field_length_exceeded');
  expect(rejected.detail?.[0]?.path, 'the rejection names the exact entry path')
    .toBe('column_flow.0.upstream_columns.0.note');
  expect(rejected.hint, 'the rejection states the measured length against the limit')
    .toContain(`${COLUMN_FLOW_NOTE_MAX + 1} chars, limit ${COLUMN_FLOW_NOTE_MAX}`);

  const after = engine.toJSON();
  expect(Object.keys(after.memory.detailSlots).length, 'no archive mutation').toBe(Object.keys(before.memory.detailSlots).length);
  expect(after.agenda.length, 'no agenda mutation').toBe(before.agenda.length);
  expect(after.columnAspect?.edges.length ?? 0, 'no column edge is staged').toBe(before.columnAspect?.edges.length ?? 0);
});

  // m17-head-azure-foundry run-T7: a CT hop that omits the required `column_flow` array entirely
  // (not the wrong type, absent altogether) rejected identically 5 times running because the
  // hint was only the bare Zod message ("column_flow: Invalid input: expected array, received
  // undefined") with no repair instruction — a model told nothing beyond that regenerates the
  // same omission. This pins that the handler's own reject path names the omission and directs
  // the addition repair, the same general treatment `rejectionFromZodError` already gives every
  // other omitted-field `invalid_tool_input` reject (`missingFieldRepairHint`).
  it("CT omitting column_flow entirely is told to add it, not just shown the bare Zod message", () => {
  const { engine, services, result } = setupCt();
  const before = engine.toJSON();
  const raw = {
    focus_node_id: 'origin',
    sections: [{ angle: 'business', text: 'Origin reads amount from base_table.' }],
    summary: 'Origin reads amount from base_table.',
    verdict: 'analyze',
    route_requests: engine.requiredNeighborIds('origin').map(id => ({ nodeId: id, question: 'what does this contribute?' })),
    // column_flow deliberately absent — CT requires it (SubmitFindingsCtInputSchema).
  };
  executeSubmitFindings(raw, services);

  const rejected = result() as { error?: string; hint?: string };
  expect(rejected.error, 'CT names its own required-field rejection code').toBe('ct_field_required');
  expect(rejected.hint ?? '', 'the hint still names the offending field').toContain('column_flow');
  expect(rejected.hint ?? '', 'the hint states the field is missing entirely, not just wrong-typed')
    .toMatch(/missing entirely/);
  expect(rejected.hint ?? '', 'the hint directs the model to add the field, not merely "correct" it')
    .toMatch(/add(ed)?/i);

  const after = engine.toJSON();
  expect(Object.keys(after.memory.detailSlots).length, 'no archive mutation').toBe(Object.keys(before.memory.detailSlots).length);
  expect(after.agenda.length, 'no agenda mutation').toBe(before.agenda.length);
});

  it("repair:true is rejected by the strict full BB boundary", () => {
  const { engine, services, result } = setup();
  const before = engine.toJSON();
  executeSubmitFindings({
    repair: true,
    focus_node_id: 'origin',
    sections: [{ angle: 'business', text: 'Repair must not be a second protocol.' }],
    summary: 'Repair must not be a second protocol.',
    verdict: 'analyze',
  }, services);
  const rejected = result() as { error?: string; hint?: string };
  expect(rejected.error, 'repair:true is rejected by the strict full BB boundary').toBe('invalid_input');
  expect(/repair/i.test(rejected.hint ?? ''), 'strict rejection identifies the unknown repair field').toBe(true);
  const after = engine.toJSON();
  expect(Object.keys(after.memory.detailSlots).length, 'repair-shaped rejection commits no detail').toBe(Object.keys(before.memory.detailSlots).length);
  expect(after.agenda.length, 'repair-shaped rejection commits no agenda mutation').toBe(before.agenda.length);
});

  it("BB preserves the established CT-field rejection envelope", () => {
  const { services, result } = setup();
  executeSubmitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business', text: 'Wrong mode field.' }],
    summary: 'Wrong mode field.',
    verdict: 'analyze',
    column_flow: [],
  }, services);
  expect((result() as { error?: string }).error, 'BB preserves the established CT-field rejection envelope').toBe('bb_field_unknown');
});

  // BB's dispatched schema (`SubmitFindingsBbInputSchema` -> `BbRouteRequestSchema`,
  // `toolSchemas.ts`) never advertises the CT-only `route_requests[].columns` decision, so a BB
  // hop naming it anyway fails `.strict()` and rejects through the generic invalid-input path —
  // the same treatment every other unrecognized BB field gets (see the `repair:true` case above).
  // A prior revision of this handler silently deleted the field from a local copy instead; that
  // was a call-site rewrite of an AI decision, forbidden by `.claude/rules/ai-surface.md`, and this
  // is its regression pin: the field must never reach the engine AND the hop must never commit as
  // if the field had been honoured.
  it("BB rejects a per-neighbour column decision instead of silently stripping it", () => {
  const { engine, services, result } = setup();
  const before = engine.toJSON();
  const reachedEngine: Array<{ route_requests?: Array<Record<string, unknown>> }> = [];
  const engineSubmit = engine.submitFindings.bind(engine);
  (engine as unknown as { submitFindings: (finding: never) => unknown }).submitFindings = (finding: never) => {
    reachedEngine.push(finding);
    return engineSubmit(finding);
  };
  const raw = {
    focus_node_id: 'origin',
    sections: [{ angle: 'business', text: 'Origin dispatches both paths.' }],
    summary: 'Origin dispatches both paths.',
    verdict: 'analyze',
    route_requests: [
      { nodeId: 'a', question: 'Trace A.', columns: 'none' },
      { nodeId: 'b', question: 'Trace B.' },
    ],
  };
  executeSubmitFindings(raw, services);
  const rejected = result() as { error?: string; hint?: string };
  expect(rejected.error, 'a BB call naming the CT-only field rejects rather than being silently rewritten').toBe('invalid_input');
  expect(rejected.hint ?? '', 'the rejection names the offending path').toMatch(/route_requests/);
  expect(reachedEngine.length, 'a rejected hop never reaches the engine').toBe(0);
  expect(engine.toJSON(), 'nothing commits from a rejected hop').toEqual(before);
  expect(raw.route_requests[0].columns, 'the raw model payload stays immutable').toBe('none');
});

  it("CT strips an undeclared column_flow key instead of rejecting the hop", () => {
  // A provider surplus key is absence-equivalent to every reader (`columnTracer.ts`, `smBase.ts`
  // only read the declared fields), so the schema drops it instead of spending a generation on a
  // rejection; the model port logs the drop (`droppedKeyPaths`).
  const { engine, services, result } = setupCt();
  const reachedEngine: Array<{ column_flow?: Array<Record<string, unknown>> }> = [];
  const engineSubmit = engine.submitFindings.bind(engine);
  (engine as unknown as { submitFindings: (finding: never) => unknown }).submitFindings = (finding: never) => {
    reachedEngine.push(finding);
    return engineSubmit(finding);
  };
  const raw = {
    focus_node_id: 'origin',
    sections: [{ angle: 'business', text: 'Origin reads amount from base_table.' }],
    summary: 'Origin reads amount from base_table.',
    verdict: 'analyze',
    column_flow: [
      { out_col: 'amount', upstream_columns: [{ node: 'base_table', col: 'raw_amount' }], bogus_field: 'nope' },
    ],
    route_requests: engine.requiredNeighborIds('origin').map(id => ({ nodeId: id, question: 'what does this contribute?', columns: ['amount'] })),
  };
  executeSubmitFindings(raw, services);
  const accepted = result() as { error?: string };
  expect(accepted.error, 'an undeclared column_flow key never costs a generation').toBeUndefined();
  expect(
    reachedEngine[0]?.column_flow?.some(entry => 'bogus_field' in entry),
    'the undeclared key never reaches the engine',
  ).toBe(false);
  expect((raw.column_flow[0] as Record<string, unknown>).bogus_field, 'the raw model payload stays immutable').toBe('nope');
});

  it("CT accepts prune_neighbors — same decision space as BB", () => {
  const { services, result } = setupCt();
  executeSubmitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business', text: 'Neighbor prune is a shared BB field.' }],
    summary: 'Neighbor prune is a shared BB field.',
    verdict: 'analyze',
    column_flow: [],
    prune_neighbors: ['base_table'],
  }, services);
  const outcome = result() as { error?: string };
  // CT is BB plus column tracking, so the CT form carries the same `prune_neighbors` field BB
  // does; the handler only proves the form accepts the key, not what the engine does with a
  // given target (pinned in the sm engine suites via currentHopActionPolicy).
  expect(outcome.error, 'CT no longer rejects prune_neighbors as a foreign field').not.toBe('bb_field_forbidden_in_ct');
});

  it("handler delegates completed-status authority to NavigationEngine", () => {
  const { engine, services, result } = setup();
  let engineCalls = 0;
  (engine as any)._status = 'complete';
  engine.submitFindings = (() => {
    engineCalls++;
    return { error: 'invalid_status', current_status: 'complete', hint: 'engine-owned status rejection' };
  });
  executeSubmitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business', text: 'Complete status probe.' }],
    summary: 'Complete status probe.',
    verdict: 'analyze',
  }, services);
  expect(engineCalls, 'handler delegates completed-status authority to NavigationEngine').toBe(1);
  expect(JSON.stringify(result()), 'engine invalid_status=complete maps to the byte-stable exploration_complete envelope').toBe(JSON.stringify({
      error: 'exploration_complete',
      hint: 'Hop loop is closed - every scope node has been analyzed and the archive is sealed. Call lineage_present_result to assemble the final report from the archive. Do not retry submit_findings.',
      next_action: 'present_result',
    }));
});

  it("handler delegates focus alignment authority to NavigationEngine", () => {
  const { engine, services, result } = setup();
  let engineCalls = 0;
  engine.submitFindings = (() => {
    engineCalls++;
    return { error: 'focus_mismatch', expected: 'origin', got: 'a' };
  });
  executeSubmitFindings({
    focus_node_id: 'a',
    sections: [{ angle: 'business', text: 'Focus mismatch probe.' }],
    summary: 'Focus mismatch probe.',
    verdict: 'analyze',
  }, services);
  expect(engineCalls, 'handler delegates focus alignment authority to NavigationEngine').toBe(1);
  expect(JSON.stringify(result()), 'engine focus_mismatch maps to the byte-stable focus_node_id_mismatch envelope').toBe(JSON.stringify({
      error: 'focus_node_id_mismatch',
      expected: 'origin',
      got: 'a',
      hint: 'submit_findings.focus_node_id must match the current focus node. Expected: origin. Resubmit with the correct focus_node_id.',
    }));
});

  it("real engine invalid_focus_node preserves authored casing in the byte-stable invalid_input envelope, hint now names the expected id", () => {
  const { engine, services, result } = setup();
  const before = JSON.stringify(engine.toJSON());
  executeSubmitFindings({
    focus_node_id: 'MissingCase',
    sections: [{ angle: 'business', text: 'Unknown focus probe.' }],
    summary: 'Unknown focus probe.',
    verdict: 'analyze',
  }, services);
  expect(JSON.stringify(result()), 'real engine invalid_focus_node preserves authored casing in the byte-stable invalid_input envelope, hint now names the expected id').toBe(JSON.stringify({
      error: 'invalid_input',
      message: 'focus_node_id `MissingCase` not found in the loaded model.',
      hint: 'Retry lineage_submit_findings with the exact current-hop focus_node.id: `origin`.',
    }));
  expect(JSON.stringify(engine.toJSON()), 'unknown focus commits zero engine state through the real handler path').toBe(before);
});

  // Per-hop progress echo. The chat status trail is composed from the accepted payload's
  // `summary` and `verdict`, so both halves are pinned: the handler accepts each shape the
  // echo has to render, and the composition rule that reads them.
  it.each([
    { label: 'an analyze commit with a summary', summary: 'Not on the path.', verdict: 'analyze' as const, sections: [{ angle: 'business', text: 'Nothing relevant here.' }] as Array<{ angle: 'business'; text: string }> },
    { label: 'a prune commit, which the echo marks', summary: 'Not on the path.', verdict: 'prune' as const, sections: [] as Array<{ angle: 'business'; text: string }> },
    { label: 'an empty summary, which the echo skips', summary: '', verdict: 'prune' as const, sections: [] as Array<{ angle: 'business'; text: string }> },
  ])('the handler accepts $label', ({ summary, verdict, sections }) => {
  const { engine, services, result } = setup();
  executeSubmitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business', text: 'Origin dispatches both paths.' }],
    summary: 'Origin dispatches both paths.',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'a', question: 'Trace A.' }, { nodeId: 'b', question: 'Trace B.' }],
  }, services);
  expect((result() as { error?: string }).error === undefined, 'the origin hop commits').toBe(true);

  const focus = (engine.getHopContext() as { focus_node?: { id: string } }).focus_node;
  expect(focus?.id !== undefined, 'a second hop is dispatched to submit against').toBe(true);
  executeSubmitFindings({
    focus_node_id: focus!.id,
    sections,
    summary,
    verdict,
  }, services);
  // Length is never a rejection axis, so an empty summary commits and the echo is what skips it.
  expect((result() as { error?: string }).error === undefined, `the shape reaches the echo (got ${JSON.stringify(result())})`).toBe(true);
});

});
