/** Fixed-response runtime wiring preserves CS twins and CI normalization through dirty SQL, active hops and synthesis. */
import { beforeAll, describe, expect, it } from 'vitest';
import { buildModel, normalizeName } from '../../../src/engine/modelBuilder';
import { buildGraphologyGraph } from '../../../src/engine/graphBuilder';
import { normalizeColName } from '../../../src/utils/sql';
import { AiSession } from '../../../src/ai/session/session';
import { EMPTY_AI_TEMPLATES } from '../../../src/ai/session/types';
import { LineageRuntime } from '../../../src/ai/runtime/lineageRuntime';
import { TurnEventSink, type TurnEvent } from '../../../src/ai/runtime/turnEventSink';
import { buildAiToolRegistry } from '../../../src/ai/tools/toolProvider';
import { modelToolCallMessage, type ModelPort, type ToolGenerationInput } from '../../../src/ai/model/modelPort';
import { DEFAULT_TURN_TOKEN_BUDGET } from '../../../src/ai/support/tokenBudget';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { deriveStagePromptContext } from '../../../src/ai/prompting/hostPrompts';
import type { ColumnFlowEntry } from '../../../src/ai/sm/smTypes';
import { loadParseRules } from '../helpers/testUtils';

beforeAll(() => { loadParseRules(); });

function dirtyCatalog(cs: boolean) {
  const columns = (names: string[]) => names.map(name => ({ name, type: 'int', nullable: 'NOT NULL', extra: '' }));
  const rootSql = cs ? `CREATE VIEW [dbo].[Report] AS
    WITH [Odd Alias] AS (SELECT [s].[Value], [s].[value] FROM [Sales].[Source] AS [s])
    SELECT a.[Value] + q.[Value] + x.[Value] AS [Value], b.[value] + y.[value] AS [value]
    FROM [Sales].[Calc](1) AS a
    INNER JOIN "Sales"."calc"(2) AS b ON a.[Value] = b.[value]
    JOIN [Odd Alias] q ON q.[Value] = a.[Value]
    JOIN [sales].[Source] x ON x.[Value] = q.[Value]
    JOIN [Sales].[source] y ON y.[value] = b.[value];`
    : `CREATE VIEW dbo.Report AS
    WITH [Odd Alias] AS (SELECT s.[vALuE] FROM sALES.SOURCE AS s)
    SELECT a.[VALUE] + q.[value] AS [Value]
    FROM "SALES"."cALC"(1) AS a JOIN [Odd Alias] q ON q.[value] = a.[VALUE];`;
  const objects = [
    { fullName: '[dbo].[Report]', type: 'view' as const, columns: columns(cs ? ['Value', 'value'] : ['Value']), bodyScript: rootSql },
    { fullName: '[Sales].[Source]', type: 'table' as const, columns: columns(cs ? ['Value', 'value'] : ['Value']) },
    { fullName: '[Sales].[Calc]', type: 'function' as const, columns: columns(['Value']), bodyScript: 'CREATE FUNCTION [Sales].[Calc](@p int) RETURNS TABLE AS RETURN SELECT t.[Value] FROM [Sales].[Source] t WHERE t.[Value] > @p;' },
    ...(cs ? [
      { fullName: '[Sales].[source]', type: 'table' as const, columns: columns(['value']) },
      { fullName: '[sales].[Source]', type: 'table' as const, columns: columns(['Value']) },
      { fullName: '[Sales].[calc]', type: 'function' as const, columns: columns(['value']), bodyScript: 'CREATE FUNCTION "Sales"."calc"(@P int) RETURNS TABLE AS RETURN SELECT t.[value] FROM [Sales].[source] AS t WHERE t.[value] > @P;' },
    ] : []),
  ];
  return buildModel(objects, [], objects, undefined, false, undefined, cs);
}

function committedState(engine: NavigationEngine) {
  const snapshot = engine.toJSON();
  return { agenda: snapshot.agenda, nodeStates: snapshot.nodeStates, scope: snapshot.scopeNodeIds, columns: snapshot.columnAspect,
    details: snapshot.memory.detailSlots, verdicts: snapshot.memory.verdictCounts };
}

describe.each([false, true])('dirty catalog through real runtime (CS=%s)', cs => {
  it.each(['bb', 'ct'] as const)('keeps source identity through %s approval, hops, repair, synthesis and the captured run record', async mode => {
    const model = dirtyCatalog(cs);
    expect(model.edges.length, JSON.stringify(model.parseStats)).toBeGreaterThan(0);
    const session = new AiSession({ ...EMPTY_AI_TEMPLATES, technical_capture: 'Capture the supplied SQL.', structural_summary: 'Describe source columns.' });
    session.model = model;
    session.graph = buildGraphologyGraph(model);
    expect(deriveStagePromptContext(model, null).identifierCaseSensitive).toBe(cs ? true : undefined);
    const id = (name: string) => normalizeName(name, cs);
    const root = id('dbo.Report');
    const calls: ToolGenerationInput[] = [];
    const visited: string[] = [];
    let providerCalls = 0;
    let rejectedOnce = false;
    let beforeRejected: ReturnType<typeof committedState> | undefined;
    const scripted: ModelPort = {
      id: 'fixed-catalog-flow', identity: { id: 'fixed-catalog-flow', name: 'Fixed Catalog Flow', vendor: 'test', family: 'test', version: '1' },
      budget: DEFAULT_TURN_TOKEN_BUDGET,
      get modelCalls() { return providerCalls; },
      async getNumTokens(content) { return String(content).length; },
      async generateStructured() { throw new Error('Slash routing must not call entry classification.'); },
      async completeText() { providerCalls++; return 'Trace the supplied catalog.'; },
      async generateToolTurn(input) {
        providerCalls++;
        calls.push(input);
        let toolName: string;
        let payload: Record<string, unknown>;
        if (input.tools.some(tool => tool.name === 'lineage_start_exploration')) {
          toolName = 'lineage_start_exploration';
          payload = { origin: cs ? 'dbo.Report' : 'DBO.REPORT', analysisMode: mode, classification: 'technical',
            depth: { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } },
            ...(mode === 'ct' ? { targetColumns: cs ? ['Value', 'value'] : ['[VALUE]'] } : {}),
          };
        } else if (input.tools.some(tool => tool.name === 'lineage_submit_findings')) {
          toolName = 'lineage_submit_findings';
          const engine = session.stateMachine!;
          if (!(engine instanceof NavigationEngine)) throw new Error('Active phase requires the production navigation engine.');
          const focus = engine.currentFocus!;
          if (beforeRejected) {
            expect(committedState(engine)).toEqual(beforeRejected);
            beforeRejected = undefined;
          }
          const active = [...new Map((engine.columnAspect?.active_columns ?? []).map(col => [normalizeColName(col, cs), col])).values()];
          const flow: ColumnFlowEntry[] = active.map(col => ({ out_col: col, upstream_columns: focus === root
            ? (cs && col === 'value' ? [{ node: 'Sales.calc', col: 'value' }, { node: 'Sales.source', col: 'value' }]
              : [{ node: cs ? 'Sales.Calc' : 'SALES.CALC', col: cs ? 'Value' : '[vALuE]' }, { node: cs ? 'Sales.Source' : 'sales.source', col: cs ? 'Value' : 'VALUE' }, ...(cs ? [{ node: 'sales.Source', col: 'Value' }] : [])])
            : [{ node: focus === id('Sales.calc') && cs ? 'Sales.source' : (cs ? 'Sales.Source' : 'SALES.SOURCE'), col: cs ? col : '[VALUE]' }],
          }));
          payload = { focus_node_id: cs ? focus : focus.toUpperCase(), verdict: 'analyze', summary: `Records ${focus}.`, sections: { technical: `Observed ${focus} from its supplied definition.` },
            ...(engine.currentHopAnalysisMode === 'ct' ? { column_flow: flow } : {}),
          };
          if (cs && !rejectedOnce && focus === root) {
            beforeRejected = structuredClone(committedState(engine));
            rejectedOnce = true;
            payload = mode === 'ct'
              ? { ...payload, column_flow: [{ out_col: 'VALUE', upstream_columns: [] }] }
              : { ...payload, focus_node_id: '[DBO].[REPORT]' };
          } else visited.push(focus);
        } else {
          toolName = 'lineage_present_result';
          const ids = session.resultGraph!.nodeIds;
          payload = { name: 'Catalog lineage', summary: 'Catalog dependencies and columns.',
            sections: ids.map((nodeId, i) => ({ label: `Object ${i + 1}`, node_ids: [cs ? nodeId : nodeId.toUpperCase()], text: session.memory.getResult().detail_slots.find(slot => slot.nodeId === nodeId)?.sections.map(section => section.text).join('\n') ?? 'Source structure.' })),
            highlight_groups: [{ label: 'Lineage', color: 'source', node_ids: ids }],
          };
        }
        const call = { valid: true as const, callId: `call-${providerCalls}`, toolName, input: payload };
        return { status: 'completed' as const, content: [], message: modelToolCallMessage([call]), text: '', toolCalls: [call], finishReason: 'tool-calls' };
      },
    };
    const noop = () => {};
    const channel = { info: noop, debug: noop, warn: noop, error: noop } as unknown as Parameters<typeof buildAiToolRegistry>[1];
    const runtime = new LineageRuntime({ getSession: () => session,
      createRegistry: (lease, port) => buildAiToolRegistry(() => session, channel, () => undefined, lease, { model: port }),
    });
    const events: TurnEvent[] = [];
    const result = await runtime.run({ model: scripted, request: { id: `flow-${cs}-${mode}`, prompt: mode === 'ct'
      ? `/trace [dbo].[Report].[Value]${cs ? ' and [dbo].[Report].[value]' : ''}` : '/trace [dbo].[Report]' },
      sink: new TurnEventSink(event => { events.push(event); if (event.type === 'gate') void runtime.resumeGate(event.gateId, { kind: 'approve', classes: [...event.classes ?? []] }); }),
    });
    expect(result, JSON.stringify({ events, calls: session.hopLog })).toMatchObject({ outcome: 'ok' });
    expect(events.filter(event => event.type === 'gate')).toHaveLength(1);
    expect(session.phase.kind).toBe('completed');
    expect(new Set(session.presentationArtifact?.nodeIds)).toEqual(new Set(model.nodes.map(node => node.id)));
    expect(new Set(visited)).toEqual(new Set(model.nodes.filter(node => node.type === 'view' || node.type === 'function').map(node => node.id)));
    expect(calls.some(call => call.instructionContext?.classification === 'technical' && call.tools.some(tool => tool.name === 'lineage_submit_findings'))).toBe(true);
    expect(calls.some(call => call.instructionContext?.classification === 'technical' && call.tools.some(tool => tool.name === 'lineage_present_result'))).toBe(true);
    for (const call of calls) expect(call.system?.includes('Identifiers are case-sensitive.')).toBe(cs);
    if (mode === 'ct') {
      const edges = (session.presentationArtifact?.aiMetadata.columnAspect?.edges ?? []).map(edge => ({ ...edge,
        fromCol: normalizeColName(edge.fromCol, cs), toCol: normalizeColName(edge.toCol, cs) }));
      expect(edges).toEqual(expect.arrayContaining([expect.objectContaining({ fromNode: id('Sales.Source'), fromCol: cs ? 'Value' : 'value', toNode: root, toCol: cs ? 'Value' : 'value' })]));
      if (cs) expect(edges).toEqual(expect.arrayContaining([
        expect.objectContaining({ fromNode: id('Sales.source'), fromCol: 'value', toNode: root, toCol: 'value' }),
        expect.objectContaining({ fromNode: id('sales.Source'), fromCol: 'Value', toNode: root, toCol: 'Value' }),
      ]));
      expect(edges.some(edge => edge.toCol === 'VALUE')).toBe(false);
    }
    const checkpoint = session.presentationArtifact!.checkpoint!;
    expect(checkpoint.identifierCaseSensitive).toBe(cs);
    expect(checkpoint).toEqual(session.stateMachine!.toJSON());
  });
});
