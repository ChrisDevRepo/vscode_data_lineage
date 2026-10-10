/**
 * Tool trace records separate corrections the model is charged for from control outcomes: a gate
 * carries no rejection code, an admission refusal is `refused`, and a sibling closed without
 * evaluation is `not_evaluated`. Scripted replies exercise runtime wiring only, not inference.
 */
import { describe, expect, it, vi } from 'vitest';
import { LineageRuntime } from '../../../src/ai/runtime/lineageRuntime';
import { TurnEventSink } from '../../../src/ai/runtime/turnEventSink';
import { AiSession } from '../../../src/ai/session/session';
import type { ModelPort } from '../../../src/ai/model/modelPort';
import type { AiTraceRecord, AiTraceWriter } from '../../../src/ai/observability/aiTraceWriter';
import { ScriptedModelPort, scriptedRegistry, validCall } from '../../harness/scriptedModelPort';
import { makeModel, makeNode } from '../sm/helpers/fixtures';

const ORIGIN = '[d].[origin]';
const start = (id: string) => validCall(id, 'lineage_start_exploration', { origin: ORIGIN, analysisMode: 'bb', classification: 'technical' });

async function run(startResult: string, onGate?: (runtime: LineageRuntime, gateId: string) => void) {
  const session = new AiSession();
  session.model = makeModel([makeNode({ id: ORIGIN, schema: 'd', name: 'origin', type: 'table' })], [], ['d']);
  const records: AiTraceRecord[] = [];
  const traceWriter = { write: vi.fn(async (record: AiTraceRecord) => { records.push(record); }), writeTurnEvent: vi.fn(async () => {}), isEnabled: () => true, isVerbose: () => false } as unknown as AiTraceWriter;
  const runtime = new LineageRuntime({
    getSession: () => session,
    createRegistry: () => scriptedRegistry([{ name: 'lineage_start_exploration', result: startResult }]).registry,
    traceWriter,
  });
  const model = new ScriptedModelPort([{ toolCalls: [start('first'), start('second')] }]);
  const sink = new TurnEventSink(event => { if (event.type === 'gate') onGate?.(runtime, event.gateId); });
  await runtime.run({ model: model as unknown as ModelPort, request: { id: 'status', prompt: `/trace ${ORIGIN}` }, sink });
  return records.filter((record): record is Extract<AiTraceRecord, { type: 'tool' }> => record.type === 'tool');
}

describe('tool trace record status', () => {
  it('marks an admission refusal refused and the closed sibling not_evaluated', async () => {
    const tools = await run(JSON.stringify({ code: 'over_active_scope_budget', reason: 'The scope is too large.' }));
    expect(tools.map(tool => [tool.status, tool.rejectionCode])).toEqual([
      ['refused', 'over_active_scope_budget'],
      ['not_evaluated', 'phase_closed'],
    ]);
  });

  it('records a consent gate without a rejection code', async () => {
    const gate = JSON.stringify({ code: 'action_required', reason: 'review revision 1',
      detail: { gate: 'confirm_sm_start', classes: [], nodeIds: [], detail: 'review revision 1', proposalRevision: 1 } });
    const tools = await run(gate, (runtime, gateId) => { void runtime.resumeGate(gateId, { kind: 'cancel' }); });
    expect(tools[0]).toMatchObject({ status: 'gate' });
    expect(tools[0]).not.toHaveProperty('rejectionCode');
    expect(tools[1]).toMatchObject({ status: 'not_evaluated', rejectionCode: 'phase_closed' });
  });
});
