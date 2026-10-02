/** Completed hop summaries persist as text with their original identity; transient statuses and memory remain intact. */
import { describe, expect, it } from 'vitest';
import { marked } from 'marked';
import { AgentRuntime } from '../../../src/ai/host/agentRuntime';
import type { ModelPort } from '../../../src/ai/model/modelPort';
import { TurnEventSink, type NativeGateEvent, type TurnEvent } from '../../../src/ai/runtime/turnEventSink';
import { AiSession } from '../../../src/ai/session/session';
import type { PresentationArtifact } from '../../../src/ai/session/types';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { HopSubmission } from '../../../src/ai/sm/smTypes';
import { makeGraph } from '../../../tests/unit/helpers/testUtils';
import { makeModel, makeNode } from '../../../tests/unit/sm/helpers/fixtures';
import { ScriptedModelPort, scriptedRegistry, validCall } from '../../harness/scriptedModelPort';

const GATE_RESULT = JSON.stringify({
  code: 'action_required',
  reason: 'review revision 1',
  detail: {
    gate: 'confirm_sm_start',
    classes: [],
    nodeIds: [],
    detail: 'review revision 1',
    proposalRevision: 1,
  },
});

/** Well above the chat display budget; a repeated clause gives word boundaries to fold at. */
const LONG_SUMMARY = 'Origin joins the customer and order tables on the shared key before aggregating totals. '.repeat(6).trim();
const SHORT_SUMMARY = 'Origin joins the customer and order tables.';

/** Seeds a real BFS graph: one origin fanning out (upstream) to `leafCount` sibling leaves. */
function seedFanOutLineage(session: AiSession, leafCount: number): string[] {
  const leaves = Array.from({ length: leafCount }, (_, i) => `[ai].[Leaf${i}]`);
  const nodes = [
    makeNode({ id: '[ai].[Origin]', schema: 'ai', name: 'Origin', type: 'view', bodyScript: 'CREATE VIEW [ai].[Origin] AS SELECT 1 AS X' }),
    ...leaves.map(id => makeNode({ id, schema: 'ai', name: id.replace(/[[\]]/g, '').split('.')[1], type: 'view', bodyScript: `CREATE VIEW ${id} AS SELECT 1 AS X` })),
  ];
  const edges: Array<[string, string]> = leaves.map(id => [id, '[ai].[Origin]']);
  session.model = makeModel(nodes, edges, ['ai']);
  session.graph = makeGraph(
    nodes.map(n => ({ id: n.id, schema: n.schema, name: n.name, type: n.type })),
    edges,
  );
  return leaves;
}

function seedProposal(session: AiSession, epoch: number, scopeCount: number): void {
  session.storePendingExploration({
    init: {
      question: 'Trace Origin upstream.',
      origin: '[ai].[Origin]',
      analysisMode: 'bb',
      direction: 'upstream',
      depthIntent: { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 'all', exactness: 'exact' } },
    },
    classification: 'business',
    activeFilter: {
      schemas: [],
      types: [],
      hideIsolated: false,
      focusSchemas: [],
      showExternalRefs: false,
      externalRefTypes: [],
    },
    summary: {
      hopCount: scopeCount,
      scopeCount,
      origin: '[ai].[Origin]',
      depth: null,
      depthIntent: { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 'all', exactness: 'exact' } },
      direction: 'upstream',
      analysisMode: 'bb',
      columnAspectActive: false,
      estimatedDdlChars: 0,
      estimatedDdlTokens: 0,
      bySchema: {
        ai: {
          hops: scopeCount,
          scope: scopeCount,
          byType: { view: { hops: scopeCount, scope: scopeCount, nodeNames: [], omitted: 0 } },
        },
      },
      scopeNotes: [],
      activeFilters: { schemas: [], types: [], nodeIds: [], passNodeIds: [] },
    },
  }, epoch);
}

/** Collects turn events and hands out each native gate as it is emitted. */
function makeGateSink() {
  const events: TurnEvent[] = [];
  const waiters: Array<(gate: NativeGateEvent) => void> = [];
  const pending: NativeGateEvent[] = [];
  const sink = new TurnEventSink((event) => {
    events.push(event);
    if (event.type !== 'gate') return;
    const waiter = waiters.shift();
    if (waiter) waiter(event);
    else pending.push(event);
  });
  const nextGate = (): Promise<NativeGateEvent> => {
    const gate = pending.shift();
    return gate ? Promise.resolve(gate) : new Promise(resolve => waiters.push(resolve));
  };
  return { events, sink, nextGate };
}

/**
 * Submits through the REAL engine and, on acceptance, dequeues the next agenda entry — mirroring
 * `submitFindings.ts`'s own post-commit `getHopContext()` call.
 */
function submitAndAdvance(engine: NavigationEngine, finding: HopSubmission) {
  const result = engine.submitFindings(finding);
  if (!('code' in result)) engine.getHopContext();
  return result;
}

/** Commits a minimal presentation artifact through the same public, turn-guarded write the real handler uses. */
function commitStubPresentation(session: AiSession, epoch: number): string {
  session.commitPresentResultSuccess(epoch, {
    name: 'Test Result',
    nodeIds: [],
    aiMetadata: { summary: 'test', description: 'test' },
  } as unknown as PresentationArtifact);
  return JSON.stringify({ ok: true });
}

const statusLabels = (events: readonly TurnEvent[]): string[] =>
  events.filter((e): e is Extract<TurnEvent, { type: 'status' }> => e.type === 'status').map(e => e.label);

/**
 * Runs one approved two-hop turn through the real runtime. The scripted handler commits
 * `LONG_SUMMARY` for the origin and `SHORT_SUMMARY` for the leaf; `leafCallSummary` is what the
 * model's leaf call itself carries.
 */
async function hopSummaryLabelsForTurn(leafCallSummary: string, leafCommittedSummary = SHORT_SUMMARY, leafVerdict: 'analyze' | 'end_branch' = 'analyze', cancelBeforeLeafCommit = false): Promise<{ labels: string[]; events: TurnEvent[]; archive: string; requests: string }> {
  const session = new AiSession();
  const leaves = seedFanOutLineage(session, 1);
  const epoch = session.beginTurn();
  seedProposal(session, epoch, leaves.length + 1);

  const controller = new AbortController();
  const { registry } = scriptedRegistry([
    { name: 'lineage_search_objects', result: JSON.stringify({ matches: [] }) },
    { name: 'lineage_start_exploration', result: GATE_RESULT },
    {
      name: 'lineage_submit_findings',
      result: (): string => {
        const engine = session.stateMachine as NavigationEngine;
        const isOrigin = engine.currentFocus === '[ai].[Origin]';
        if (!isOrigin && cancelBeforeLeafCommit) { controller.abort(); return JSON.stringify({ error: 'cancelled' }); }
        const finding: HopSubmission = !isOrigin && leafVerdict === 'end_branch'
          ? { focus_node_id: engine.currentFocus!, verdict: 'end_branch', reason: leafCommittedSummary }
          : {
              focus_node_id: engine.currentFocus!,
              sections: [{ angle: 'business', text: isOrigin ? LONG_SUMMARY : leafCommittedSummary }],
              summary: isOrigin ? LONG_SUMMARY : leafCommittedSummary,
              verdict: 'analyze',
              ...(isOrigin ? { questions: leaves.map(id => ({ nodeId: id, question: `origin of ${id}?` })) } : {}),
            };
        return JSON.stringify(submitAndAdvance(engine, finding));
      },
    },
    { name: 'lineage_present_result', result: () => commitStubPresentation(session, epoch) },
  ]);

  const script = [
    { toolCalls: [validCall('start-1', 'lineage_start_exploration', { origin: '[ai].[Origin]', analysisMode: 'bb', classification: 'business' })] },
    { toolCalls: [validCall('submit-origin', 'lineage_submit_findings', { summary: LONG_SUMMARY, verdict: 'analyze' })] },
    { toolCalls: [validCall('submit-leaf-0', 'lineage_submit_findings', leafVerdict === 'end_branch' ? { reason: leafCallSummary, verdict: leafVerdict } : { summary: leafCallSummary, verdict: leafVerdict })] },
    { toolCalls: [validCall('present-1', 'lineage_present_result', {})] },
  ];
  const model = new ScriptedModelPort(script);
  const turn = makeGateSink();
  const runtime = new AgentRuntime({
    threadId: 'hop-summary-visibility',
    getSession: () => session,
    model: model as unknown as ModelPort,
    registry,
    sink: turn.sink,
    turnEpoch: epoch,
    signal: controller.signal,
    maxRounds: 10,
  });

  const running = runtime.run('/trace [ai].[Origin]');
  const gate = await turn.nextGate();
  expect(runtime.resumeGate(gate.gateId, { kind: 'approve', classes: [] })).toBe(true);
  const outcome = await running;
  expect(outcome, JSON.stringify(runtime.lastFailureDetail)).toBe(cancelBeforeLeafCommit ? 'cancelled' : 'ok');

  return {
    labels: turn.events.filter((e): e is Extract<TurnEvent, { type: 'text' }> => e.type === 'text' && e.delta.startsWith('\n\n**Hop ')).map(e => e.delta),
    events: turn.events,
    archive: JSON.stringify((session.stateMachine as NavigationEngine).toJSON().memory),
    requests: JSON.stringify(model.requests),
  };
}

describe('persistent complete committed hop summaries', () => {
  it('includes the pruned prefix and complete committed summary', async () => {
    const { labels, archive, requests } = await hopSummaryLabelsForTurn(LONG_SUMMARY, LONG_SUMMARY, 'end_branch');
    const pruned = labels.find(label => label.includes('_⛔ pruned — '));
    expect(pruned).toBeDefined();
    expect(pruned).toBe(`\n\n**Hop 2/2 — Leaf0**\n\n_⛔ pruned — ${LONG_SUMMARY}_\n\n`);
    expect(archive).toContain(LONG_SUMMARY);
    expect(requests).toContain(LONG_SUMMARY);
  });

  it('preserves complete long and short text under their actual hop identities', async () => {
    expect(LONG_SUMMARY.length).toBeGreaterThan(400);
    const {labels: hopSummaryLabels, archive, requests} = await hopSummaryLabelsForTurn(SHORT_SUMMARY);
    expect(archive).toContain(LONG_SUMMARY);
    expect(requests).toContain(LONG_SUMMARY);
    expect(hopSummaryLabels).toHaveLength(2);

    const [completeLabel, untouchedLabel] = hopSummaryLabels;
    expect(completeLabel).toBe(`\n\n**Hop 1/2 — Origin**\n\n_${LONG_SUMMARY}_\n\n`);
    expect(untouchedLabel).toBe(`\n\n**Hop 2/2 — Leaf0**\n\n_${SHORT_SUMMARY}_\n\n`);
  });

  it('shows the committed summary when the accepted call carried an empty one that a held draft supplied', async () => {
    const {labels: hopSummaryLabels} = await hopSummaryLabelsForTurn('');
    expect(hopSummaryLabels).toHaveLength(2);
    expect(hopSummaryLabels[1]).toBe(`\n\n**Hop 2/2 — Leaf0**\n\n_${SHORT_SUMMARY}_\n\n`);
  });
});


it('keeps native hop headers transient and orders each committed summary before the next hop', async () => {
  const { events, labels } = await hopSummaryLabelsForTurn(SHORT_SUMMARY);
  const statuses = statusLabels(events);
  expect(statuses.some(label => label.startsWith('Hop 1/2 — analysing Origin'))).toBe(true);
  expect(statuses.some(label => label.startsWith('Hop 2/2 — analysing Leaf0'))).toBe(true);
  expect(statuses.some(label => label.includes(LONG_SUMMARY))).toBe(false);
  const originHeader = events.findIndex(event => event.type === 'status' && event.label.startsWith('Hop 1/2'));
  const originSummary = events.findIndex(event => event.type === 'text' && event.delta === labels[0]);
  const leafHeader = events.findIndex(event => event.type === 'status' && event.label.startsWith('Hop 2/2'));
  const leafSummary = events.findIndex(event => event.type === 'text' && event.delta === labels[1]);
  expect(originHeader).toBeGreaterThanOrEqual(0); expect(originSummary).toBeGreaterThan(originHeader);
  expect(leafHeader).toBeGreaterThan(originSummary); expect(leafSummary).toBeGreaterThan(leafHeader);
});


it('cancellation before a leaf finding commits exposes only the already accepted origin summary', async () => {
  const { labels, archive } = await hopSummaryLabelsForTurn('Uncommitted leaf summary', SHORT_SUMMARY, 'analyze', true);
  expect(labels).toEqual([`\n\n**Hop 1/2 — Origin**\n\n_${LONG_SUMMARY}_\n\n`]);
  expect(archive).toContain(LONG_SUMMARY);
  expect(labels.join('')).not.toContain('Uncommitted leaf summary');
  expect(labels.join('')).not.toContain('Leaf0');
});


it('renders multiplication and identifier punctuation literally without altering archive or model history', async () => {
  const summary = 'TotalRevenue = Qty*UnitPrice; Discount = BaseAmt*DiscountPct. [Raw_Orders] <filter> & $Rate$.';
  const { labels, archive, requests } = await hopSummaryLabelsForTurn(summary, summary);
  const html = marked.parse(labels[1], { async: false });
  expect(html).toContain('Qty*UnitPrice');
  expect(html).toContain('BaseAmt*DiscountPct');
  expect(html).toContain('[Raw_Orders]');
  expect(html).toContain('&lt;filter&gt; &amp; $Rate$.');
  expect(html).not.toContain('<em>UnitPrice');
  expect(labels[1]).toContain('**Hop 2/2 — Leaf0**');
  expect(archive).toContain(summary);
  expect(requests).toContain(summary.replace(/</g, '\\\\u003c').replace(/>/g, '\\\\u003e'));
});
