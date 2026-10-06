/** Canonical CI/CS identities survive discovery, focus-template routing, recall and presentation repair. */
import { describe, expect, it } from 'vitest';
import { buildModel, normalizeName } from '../../../src/engine/modelBuilder';
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
import { presentResultRepairPatchSchemaForFields } from '../../../src/ai/tools/toolSchemas';
import { DEFAULT_TURN_TOKEN_BUDGET } from '../../../src/ai/support/tokenBudget';
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
  expect(engine.init({ origin: normalizeName('dbo.Reader', cs), question: 'Trace Value.', direction: 'upstream', analysisMode: 'ct', targetColumns: ['Value'],
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
  it('normalizes neighbor-column IDs once at the registry boundary and keeps original input', async () => {
    const { session, registry } = neighborWorld(cs);
    const input = { ids: cs
      ? ['Sales.Orders', '"Sales"."Orders"', '[Sales].[Orders]', 'Sales.orders']
      : ['SALES.ORDERS', '"sALES"."oRDERS"', '[SALES].[ORDERS]', 'Sales.orders'] };
    const before = structuredClone(input);
    const result = JSON.parse(String(await registry.invoke('lineage_get_neighbor_columns', input)));
    expect(result).toMatchObject({ total: 4, results: input.ids.map(id => ({ id: normalizeName(id, cs) })) });
    expect(result.results.every((entry: { error?: string }) => !entry.error)).toBe(true);
    if (cs) expect(result.results.map((entry: { columns: { n: string }[] }) => entry.columns[0].n)).toEqual(['Upper', 'Upper', 'Upper', 'lower']);
    expect(input).toEqual(before);
    expect(session.hopLog.at(-1)?.input).toBe(input);
  });

  it.each([['[Other].[Orders]', true], ['[Sales].[Missing]', false]] as const)('rejects unresolved or out-of-scope neighbor %s without returning columns', async (raw, found) => {
    const { registry } = neighborWorld(cs);
    const result = JSON.parse(String(await registry.invoke('lineage_get_neighbor_columns', { ids: [raw] })));
    expect(result).toMatchObject({ code: 'out_of_scope_or_not_neighbor' });
    expect(result).not.toHaveProperty('results');
    expect(result.detail.invalid_ids).toEqual([found ? normalizeName(raw, cs) : raw]);
  });

  it('preserves unresolved CS spelling in the refusal while CI accepts the case variant', async () => {
    const { registry } = neighborWorld(cs);
    const raw = 'SALES.ORDERS';
    const result = JSON.parse(String(await registry.invoke('lineage_get_neighbor_columns', { ids: [raw] })));
    expect(result).toMatchObject(cs
      ? { code: 'out_of_scope_or_not_neighbor', detail: { invalid_ids: [raw] } }
      : { results: [{ id: '[sales].[orders]' }] });
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
      const focusId = normalizeName(name, cs);
      const engine = {
        currentFocus: focusId, currentHopAnalysisMode: 'bb', currentHop: 1,
        getCurrentTasks: () => [], pendingLineageQuestions: [], peekHopContext: () => null,
      } as unknown as NavigationEngine;
      expect(buildActiveHopInstruction(session, engine, focusId).templateKeys).toContain(template);
    }
  });

  it('counts distinct canonical object-detail observations without merging CS twins', () => {
    const model = buildModel([
      { fullName: '[dbo].[Report]', type: 'table' },
      { fullName: '[dbo].[report]', type: 'table' },
    ], [], undefined, undefined, true, undefined, cs);
    const observations = ['dbo.Report', 'dbo.report', 'dbo.Report'].map((id, i) => ({
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
        identifierCaseSensitive: cs, scopeNodeIds: ['[dbo].[Report]', '[dbo].[report]'],
        removedSet: ['[dbo].[report]'], renderDroppedNodeIds: [], nodeStates: [],
        engineInternals: { pendingLeads: [
          { nodeId: '[dbo].[Report]', status: 'pending' },
          { nodeId: '[dbo].[report]', status: 'pending' },
          { nodeId: '[DBO].[REPORT]', status: 'pending' },
        ] },
      },
    } as unknown as StoredAiRun;
    const recalled = presentRunRecall({ uiState: null, liveRun: run, budget: DEFAULT_TURN_TOKEN_BUDGET, filter: 'open_leads' });
    expect(recalled).toMatchObject({ open_leads: [
      { id: '[dbo].[Report]', on_graph: cs },
      { id: '[dbo].[report]', on_graph: false },
      { id: '[DBO].[REPORT]', on_graph: false },
    ] });
  });

  it('gives valid canonical-id repair guidance for an unresolved reference', () => {
    const canonical = normalizeName('dbo.Report', cs);
    const result = validatePresentResult({
      name: 'Reports', summary: 'Reports lineage.', highlight_groups: [],
      sections: [{ label: 'Report', node_ids: ['[dbo].[REPORT]'], text: 'Report output.' }],
    }, [canonical]);
    expect(result.success).toBe(false);
    if (result.success === false) {
      expect(result.rejection.hint).toContain('exact catalog casing');
      expect(result.rejection.hint).not.toContain('Case and bracket differences are normalized automatically');
      expect(result.rejection.reason).toContain(canonical);
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
  expect(logs).toEqual(expect.arrayContaining([expect.stringContaining('get_screen_state id resolved raw=Sales.Orders')]));
});

it('gives one repair per id: a highlighted id an external violation already places is not listed again', () => {
  const id = '[ai].[vwpricelist]';
  const result = validatePresentResult({
    name: 'Prices', summary: 'Price lineage.',
    highlight_groups: [{ label: 'Prices', color: 'source', node_ids: [id] }],
    sections: [{ label: 'Other', node_ids: [], text: 'Other.' }],
  }, [id], undefined, undefined, [{
    field: 'sections',
    messages: [`Detail slot(s) reached no section: \`${id}\`.`, 'Add each id to a section\'s node_ids.'],
    repairFields: ['sections'], paths: ['sections'], entryIds: [id],
  }]);
  expect(result.success).toBe(false);
  if (result.success === false) {
    expect(result.rejection.reason).toContain('Detail slot(s) reached no section');
    expect(result.rejection.reason).not.toContain('must be explained by');
    expect(result.rejection.reason).not.toContain('notes entry');
  }
});

describe('present_result id rejection route', () => {
  const call = (state: 'pruned' | 'out_of_scope') => validatePresentResult({
    name: 'Reports', summary: 'Reports lineage.', highlight_groups: [],
    sections: [{ label: 'Report', node_ids: ['[dbo].[x]'], text: 'Report output.' }],
  }, ['[dbo].[a]'], undefined, undefined, [], 'completed', () => state);

  it('does not offer add_node_ids for an id outside the approved scope, and keeps the remove/state-in-text action', () => {
    const result = call('out_of_scope');
    expect(result.success).toBe(false);
    if (result.success === false) {
      const text = `${result.rejection.reason} ${result.rejection.hint}`;
      expect(text).not.toContain('add_node_ids');
      expect(text).toContain('Remove the named ids from node_ids, or state the fact in sections[].text.');
      expect(result.repairFields).toEqual(['sections']);
    }
  });

  it('authorizes add_node_ids in the repair whenever the rejection names it', () => {
    const result = call('pruned');
    expect(result.success).toBe(false);
    if (result.success === false) {
      expect(result.rejection.reason).toContain('brought into the view with add_node_ids');
      expect([...result.repairFields].sort()).toEqual(['add_node_ids', 'sections']);
      expect(presentResultRepairPatchSchemaForFields(result.repairFields).safeParse({ sections: [{ label: 'Report', node_ids: ['[dbo].[a]'] }], add_node_ids: ['[dbo].[x]'] }).success).toBe(true);
    }
  });
});
