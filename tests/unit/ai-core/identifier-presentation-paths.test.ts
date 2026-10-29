/** Canonical CI/CS identities survive discovery, focus-template routing, recall and presentation repair. */
import { describe, expect, it } from 'vitest';
import { buildModel } from '../../../src/engine/modelBuilder';
import { buildGraphologyGraph } from '../../../src/engine/graphBuilder';
import { buildActiveHopInstruction } from '../../../src/ai/agent/stagePrompts';
import { captureDiscoveryWalkFromObservations } from '../../../src/ai/agent/discoveryCapture';
import { AiSession } from '../../../src/ai/session/session';
import { EMPTY_AI_TEMPLATES } from '../../../src/ai/session/types';
import type { StoredAiRun } from '../../../src/ai/session/runStore';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { getObjectDetail } from '../../../src/ai/tools/tools';
import { presentRunRecall } from '../../../src/ai/tools/screenStatePresenter';
import { validatePresentResult } from '../../../src/ai/tools/presentResult';
import { DEFAULT_TURN_TOKEN_BUDGET } from '../../../src/ai/support/tokenBudget';
import { ISSUES, at, renderProblem } from '../../../src/ai/support/toolErrorEnvelope';
import { reconcileAiView } from '../../../src/components/aiViewReconcile';
import { buildAiToolRegistry } from '../../../src/ai/tools/toolProvider';

function neighborWorld(cs: boolean) {
  const column = (name: string) => ({ name, type: 'int', nullable: 'NOT NULL', extra: '' });
  const objects = [
    { fullName: '[dbo].[Reader]', type: 'view' as const, columns: [column('Value')], bodyScript: 'SELECT Value FROM [Sales].[Orders]' },
    { fullName: '[Sales].[Orders]', type: 'table' as const, columns: [column('Upper')] },
    { fullName: '[Sales].[orders]', type: 'table' as const, columns: [column('lower')] },
    { fullName: '[Other].[Orders]', type: 'table' as const, columns: [column('Unrelated')] },
  ];
  const model = buildModel(objects, ['[Sales].[Orders]', '[Sales].[orders]'].map(targetName => ({ sourceName: '[dbo].[Reader]', targetName })), objects, undefined, true, undefined, cs);
  const session = new AiSession();
  session.model = model;
  session.graph = buildGraphologyGraph(model);
  const engine = new NavigationEngine(model, session.graph, () => {}, {});
  expect(engine.init({ origin: cs ? '[dbo].[Reader]' : '[dbo].[reader]', question: 'Trace Value.', direction: 'upstream', analysisMode: 'ct', targetColumns: ['Value'],
    depthIntent: { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } },
  })).toMatchObject({ ok: true });
  engine.getHopContext();
  session.stateMachine = engine;
  session.enterExploring(session.beginTurn());
  const noop = () => {};
  const channel = { info: noop, debug: noop, warn: noop, error: noop } as unknown as Parameters<typeof buildAiToolRegistry>[1];
  const registry = buildAiToolRegistry(() => session, channel, () => undefined);
  return { session, registry };
}

describe.each([false, true])('canonical presentation identifiers (CS=%s)', cs => {
  it('binds equivalent neighbor IDs while preserving supplied values', async () => {
    const { session, registry } = neighborWorld(cs);
    const input = { ids: cs
      ? ['Sales.Orders', '"Sales"."Orders"', '[Sales].[Orders]', 'Sales.orders']
      : ['SALES.ORDERS', '"sALES"."oRDERS"', '[SALES].[ORDERS]', 'Sales.orders'] };
    const before = structuredClone(input);
    const result = JSON.parse(String(await registry.invoke('lineage_get_neighbor_columns', input)));
    expect(result).toMatchObject({ total: 4, results: (cs ? ['[Sales].[Orders]', '[Sales].[Orders]', '[Sales].[Orders]', '[Sales].[orders]']
      : ['[sales].[orders]', '[sales].[orders]', '[sales].[orders]', '[sales].[orders]']).map(id => ({ id })) });
    expect(result.results.every((entry: { error?: string }) => !entry.error)).toBe(true);
    if (cs) expect(result.results.map((entry: { columns: { n: string }[] }) => entry.columns[0].n)).toEqual(['Upper', 'Upper', 'Upper', 'lower']);
    expect(input).toEqual(before);
    expect(session.hopLog.at(-1)?.input).toBe(input);
  });

  it.each([['[Other].[Orders]'], ['[Sales].[Missing]']] as const)('rejects unresolved or out-of-scope neighbor %s without returning columns', async (raw) => {
    const { registry } = neighborWorld(cs);
    const result = JSON.parse(String(await registry.invoke('lineage_get_neighbor_columns', { ids: [raw] })));
    expect(result).toMatchObject({ code: 'out_of_scope_or_not_neighbor' });
    expect(result).not.toHaveProperty('results');
    expect(result.issuePaths).toEqual(['ids.0']);
    expect(result.errors).toEqual([{ path: 'ids.0', code: 'not_neighbor', values: expect.any(Array) }]);
  });

  it('preserves unknown spelling under either catalog case policy', async () => {
    const { registry } = neighborWorld(cs);
    const raw = 'SALES.MISSING';
    const result = JSON.parse(String(await registry.invoke('lineage_get_neighbor_columns', { ids: [raw] })));
    expect(result).toMatchObject({ code: 'out_of_scope_or_not_neighbor', issuePaths: ['ids.0'],
      errors: [{ path: 'ids.0', code: 'not_neighbor', values: expect.any(Array) }] });
  });

  it('selects the current object type without substituting an earlier case twin', () => {
    const tableName = '[dbo].[Report]';
    const viewName = cs ? '[dbo].[report]' : '[dbo].[ReportView]';
    const model = buildModel([
      { fullName: tableName, type: 'table' },
      { fullName: viewName, type: 'view', bodyScript: 'SELECT 1 AS Value' },
    ], [], undefined, undefined, true, undefined, cs);
    const session = new AiSession({ ...EMPTY_AI_TEMPLATES, structural_summary: 'Describe the table.', technical_capture: 'Describe the SQL.' });
    session.model = model;
    session.classification = 'technical';
    for (const [name, template] of [[tableName, 'structural_summary'], [viewName, 'technical_capture']] as const) {
      const focusId = cs ? name : name === tableName ? '[dbo].[report]' : '[dbo].[reportview]';
      const engine = {
        currentFocus: focusId, currentHopAnalysisMode: 'bb', currentHop: 1,
        getCurrentTasks: () => [], pendingLineageQuestions: [], peekHopContext: () => null, heldPartsOfCurrentFocus: () => null,
      } as unknown as NavigationEngine;
      expect(buildActiveHopInstruction(session, engine, focusId).templateKeys).toContain(template);
    }
  });

  it('counts distinct canonical object-detail observations without merging CS twins', () => {
    const model = buildModel([
      { fullName: '[dbo].[Report]', type: 'table' },
      { fullName: '[dbo].[report]', type: 'table' },
    ], [], undefined, undefined, true, undefined, cs);
    const observations = (cs ? ['[dbo].[Report]', '[dbo].[report]', '[dbo].[Report]']
      : ['[dbo].[report]', '[dbo].[report]', '[dbo].[report]']).map((id, i) => ({
      callId: `call-${i}`, toolName: 'lineage_get_object_detail', input: { id },
      result: JSON.stringify(getObjectDetail(model, id)),
    }));
    const walk = captureDiscoveryWalkFromObservations(observations, 'Inspected reports.');
    expect(walk).toEqual(cs ? { walkCount: 2, origin: '[dbo].[Report]', answer: 'Inspected reports.' } : null);
  });

  it('marks open leads using the stored run policy instead of folding CS twins', () => {
    const run = {
      schemaVersion: 1, runId: 'run', savedAt: '2026-10-02', origin: null, ddlHashes: {},
      snapshot: {
        identifierCaseSensitive: cs, scopeNodeIds: ['[dbo].[Report]', '[dbo].[report]', '[dbo].[Unvisited]'],
        removedSet: ['[dbo].[report]'], nodeStates: [
          ...(cs ? [{ nodeId: '[dbo].[Report]', action: 'analyze', source: 'ai', reason: 'submitted_analyze' }] : []),
          { nodeId: '[dbo].[report]', action: 'prune', source: 'ai', reason: 'submitted_prune' },
        ],
        engineInternals: { pendingLeads: [
          { nodeId: '[dbo].[Report]', status: 'pending' },
          { nodeId: '[dbo].[report]', status: 'pending' },
          { nodeId: '[DBO].[REPORT]', status: 'pending' },
          { nodeId: '[dbo].[Unvisited]', status: 'pending' },
        ] },
      },
    } as unknown as StoredAiRun;
    const recalled = presentRunRecall({ uiState: null, liveRun: run, budget: DEFAULT_TURN_TOKEN_BUDGET, filter: 'open_leads' });
    expect(recalled).toMatchObject({ open_leads: [
      { id: '[dbo].[Report]', on_graph: cs },
      { id: '[dbo].[report]', on_graph: false },
      { id: '[DBO].[REPORT]', on_graph: false },
      { id: '[dbo].[Unvisited]', on_graph: false },
    ] });
  });

  it('gives valid canonical-id repair guidance for an unresolved reference', () => {
    const canonical = cs ? '[dbo].[Report]' : '[dbo].[report]';
    const result = validatePresentResult({
      name: 'Reports', summary: 'Reports lineage.', highlight_groups: [],
      sections: [{ label: 'Report', node_ids: ['[dbo].[REPORT]'], text: 'Report output.' }],
    }, [canonical]);
    expect(result.success).toBe(false);
    if (result.success === false) {
      // The accepted canonical ids are the allowed values of the unresolved reference; the sent spelling is never echoed (D-102).
      expect(result.rejection.errors).toContainEqual({ path: 'sections.0.node_ids.0', code: 'not_found', values: [canonical] });
      for (const stage of [1, 2, 3] as const) expect(renderProblem(result.rejection, stage), 'D-102: no echoed id').not.toContain('[dbo].[REPORT]');
    }
  });
});

it.each([undefined, false, true])('recalls historical identities using the saved policy (%s) after loading the opposite policy', async historicalCs => {
  const session = new AiSession();
  session.model = buildModel([
    { fullName: '[Sales].[Orders]', type: 'table' },
    { fullName: '[Sales].[orders]', type: 'table' },
  ], [], undefined, undefined, true, undefined, !historicalCs);
  session.uiState = { screenState: { bookmark: { id: 'historical', source: 'ai' } } };
  const records = historicalCs
    ? [{ nodeId: '[Sales].[Orders]', action: 'analyze', reason: 'Upper object.' }, { nodeId: '[Sales].[orders]', action: 'prune', reason: 'Lower object.' }]
    : [{ nodeId: '[sales].[orders]', action: 'analyze', reason: 'CI object.' }];
  const run = {
    schemaVersion: 1, runId: 'saved', savedAt: '2026-10-02', origin: null, ddlHashes: {},
    snapshot: { identifierCaseSensitive: historicalCs, nodeStates: records },
  } as unknown as StoredAiRun;
  const logs: string[] = [];
  const noop = () => {};
  const channel = { info: noop, debug: (message: string) => logs.push(message), warn: noop, error: noop } as unknown as Parameters<typeof buildAiToolRegistry>[1];
  const registry = buildAiToolRegistry(() => session, channel, () => undefined, undefined, { getStoredRun: () => run });
  const input = { ids: ['Sales.Orders', '"Sales"."orders"', 'SALES.ORDERS', 'Sales.Missing'] };
  const before = structuredClone(input);
  const result = JSON.parse(String(await registry.invoke('lineage_get_screen_state', input)));
  expect(result.objects).toEqual(historicalCs ? [
    { id: '[Sales].[Orders]', decision: 'analyze', reason: 'Upper object.', stale: false, in_current_model: false },
    { id: '[Sales].[orders]', decision: 'prune', reason: 'Lower object.', stale: false, in_current_model: false },
    { id: 'SALES.ORDERS', decision: 'not_in_run' },
    { id: 'Sales.Missing', decision: 'not_in_run' },
  ] : [
    ...Array.from({ length: 3 }, () => ({ id: '[sales].[orders]', decision: 'analyze', reason: 'CI object.', stale: false, in_current_model: false })),
    { id: 'Sales.Missing', decision: 'not_in_run' },
  ]);
  expect(input).toEqual(before);
  expect(session.hopLog.at(-1)?.input).toBe(input);
  expect(logs.some(log => log.includes('id resolved'))).toBe(false);
});

it('gives one repair per id: a highlighted id an external violation already places is not listed again', () => {
  const id = '[ai].[vwpricelist]';
  const result = validatePresentResult({
    name: 'Prices', summary: 'Price lineage.',
    highlight_groups: [{ label: 'Prices', color: 'source', node_ids: [id] }],
    sections: [{ label: 'Other', node_ids: [], text: 'Other.' }],
  }, [id], undefined, undefined, [{
    errors: at('slot_unplaced', ['sections.*.node_ids'], [id]), repairFields: ['sections'], paths: ['sections'], entryIds: [id],
  }]);
  expect(result.success).toBe(false);
  if (result.success === false) expect(result.rejection.errors).toEqual([{ path: 'sections.*.node_ids', code: 'slot_unplaced', values: [id] }]);
});

describe('present_result id rejection route', () => {
  const call = (state: 'pruned' | 'out_of_scope') => validatePresentResult({
    name: 'Reports', summary: 'Reports lineage.', highlight_groups: [],
    sections: [{ label: 'Report', node_ids: ['[dbo].[a]', '[dbo].[x]'], text: 'Report output.' }],
  }, ['[dbo].[a]'], undefined, undefined, [], 'completed', () => state);

  it('does not offer add_node_ids for an id outside the approved scope, and states the fault without a leave-out remedy or an echo (D-105, D-102)', () => {
    const result = call('out_of_scope');
    expect(result.success).toBe(false);
    if (result.success === false) {
      expect(result.rejection.errors).toEqual([{ path: 'sections.0.node_ids.1', code: 'result_out_of_scope', values: ['[dbo].[a]'] }]);
      for (const stage of [1, 2, 3] as const) {
        const text = renderProblem(result.rejection, stage);
        expect(text).not.toContain('add_node_ids');
        expect(text, 'D-102: no echoed id').not.toContain('[dbo].[x]');
        expect(text).not.toMatch(/\b(drop|omit|remove|withdraw)\b/i);
      }
      expect(result.repairFields).toEqual(['sections']);
    }
  });

  it('authorizes add_node_ids in the repair whenever the rejection names it', () => {
    const result = call('pruned');
    expect(result.success).toBe(false);
    if (result.success === false) {
      expect(result.rejection.errors).toEqual([{ path: 'sections.0.node_ids.1', code: 'addable_to_result', values: ['[dbo].[a]'] }]);
      expect(ISSUES.addable_to_result.correction).toContain('add_node_ids');
      expect([...result.repairFields].sort()).toEqual(['add_node_ids', 'sections']);
    }
  });
});


it.each([false, true])('retains requested-column descriptors while reconciling object spellings (CS=%s)', cs => {
  const model = buildModel([{ fullName: '[dbo].[Target]', type: 'table', columns: [{ name: 'Value', type: 'int', nullable: 'NOT NULL', extra: '' }] }], [], undefined, undefined, true, undefined, cs);
  const metadata = { createdAt: '2026-10-22', modelName: 'Test', highlightGroups: [], badges: [],
    columnAspect: { edges: [], requested: { node: cs ? 'dbo.Target' : 'DBO.TARGET', columns: ['[Value]'] } } };
  const before = structuredClone(metadata);
  const canonical = cs ? '[dbo].[Target]' : '[dbo].[target]';
  expect(reconcileAiView([canonical], metadata, model).metadata.columnAspect).toEqual({ edges: [], requested: { node: canonical, columns: ['[Value]'] } });
  expect(reconcileAiView([], metadata, model, () => null).metadata.columnAspect).toEqual({ edges: [] });
  expect(metadata).toEqual(before);
});
