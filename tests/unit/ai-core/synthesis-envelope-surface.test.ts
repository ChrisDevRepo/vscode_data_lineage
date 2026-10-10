/**
 * The synthesis envelope carries the archived hop findings, the id set `present_result` accepts and
 * the engine facts — each captured formula once, as the hop wrote it — and keeps the SQL fence
 * citation ids that let synthesis reuse captured SQL by reference.
 */
import { describe, expect, it } from 'vitest';
import { buildSmCompletionEnvelope } from '../../../src/ai/prompting/smPrompts';
import { assignEvidenceIds, expandEvidenceRefs } from '../../../src/ai/tools/presentResult';
import type { SmResult } from '../../../src/ai/sm/smTypes';

const view = '[mart].[sales]';
const table = '[stage].[orders]';
const FORMULA = '$$Net = Qty \\times Price - ISNULL(Discount, 0)$$';
const SQL = '```sql\nSELECT o.Qty * o.Price - ISNULL(o.Discount, 0) AS Net\nFROM stage.orders o\nWHERE o.IsActive = 1\n```';

function result(): SmResult {
  return {
    status: 'complete',
    originNodeId: view,
    fullNodes: [{ id: view, s: 'mart', n: 'sales', t: 'view' }, { id: table, s: 'stage', n: 'orders', t: 'table' }],
    edges: [[table, view, 'body']],
    detail_slots: [{
      nodeId: view, schema: 'mart', name: 'sales', type: 'view',
      sections: [{ angle: 'technical', text: `**Steps**\n\n1. Net per order:\n\n${FORMULA}\n\n${SQL}` }],
      summary: 'Computes Net.',
      incoming_questions: [{ question: 'How is Net computed?', from_node: table }],
    }],
    node_states: [{ nodeId: view, action: 'analyze', source: 'ai', reason: 'submitted_analyze' }],
    columnAspect: null,
  };
}

describe('synthesis envelope surface', () => {
  const envelope = buildSmCompletionEnvelope(result(), 'How is Net computed?');
  const json = JSON.stringify(envelope);

  it('carries findings, the accepted id set and the engine facts, and no engine bookkeeping', () => {
    expect(Object.keys(envelope).sort()).toEqual(['done', 'ok', 'result', 'synthesis_reminder']);
    expect(Object.keys(envelope.result).sort()).toEqual(['detail_slots', 'originNodeId', 'scope']);
    expect(envelope.result.scope).toEqual({ node_ids: [view, table] });
    expect(envelope.result.detail_slots[0]?.incoming_questions).toEqual([{ question: 'How is Net computed?', from_node: table }]);
  });

  it('delivers each captured formula once, as the hop wrote it', () => {
    expect(json.split('Net = Qty \\\\times Price').length - 1).toBe(1);
    expect(envelope.synthesis_reminder).not.toContain('Captured formulas');
    expect(envelope.synthesis_reminder).not.toContain('Link in `sections[].node_ids`:');
  });

  it('anchors the question and keeps the flow facts', () => {
    expect(envelope.synthesis_reminder.startsWith('## Answer this question\n"How is Net computed?"')).toBe(true);
    expect(envelope.synthesis_reminder).toContain('## Flow roles');
  });

  it('states the directed writers and readers of every analyzed node', () => {
    expect(envelope.synthesis_reminder).toContain(`Analyzed nodes (engine flow facts):\n- ${view} — view: inputs: ${table}; outputs: (none)`);
  });

  it('keeps the SQL fence citation id, and a body-less reference still expands to the captured SQL', () => {
    const slotText = envelope.result.detail_slots[0]!.sections[0]!.text;
    expect(slotText).toContain('```sql S1\n');
    const { blocks } = assignEvidenceIds(result().detail_slots);
    const expanded = expandEvidenceRefs('Deciding SQL:\n\n```sql S1\n```', blocks);
    expect(expanded.text).toContain('WHERE o.IsActive = 1');
    expect(expanded.unknownIds).toEqual([]);
  });
});
