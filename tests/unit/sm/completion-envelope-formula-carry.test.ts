/**
 * Every mandatory-carry class at synthesis is enumerated; formulas were the exception.
 *
 * Measured shape (T7 @ 739076f1): the hops captured 11 `$$` blocks — `OrderQty = COALESCE(r.RawQty,
 * 0)` among them — the compose request carried all 11 inside slot prose, and the delivered answer
 * rendered 2. Node ids, which the same payload enumerates as a checklist, were all accounted for.
 * The envelope therefore states the captured blocks in the same shape, keyed by node.
 */
import { buildSmCompletionEnvelope } from '../../../src/ai/prompting/smPrompts';
import type { SmResult } from '../../../src/ai/sm/smTypes';
import { describe, expect, it } from 'vitest';

const ORIGIN = '[ai].[factsalesreport]';
const BUILDER = '[ai].[spbuildsalesreport]';
const CLEANER = '[ai].[spcleanorders]';

const QUESTION = 'Trace the TotalRevenue column in [ai].[FactSalesReport] back to its original sources.';

/** Two analyzed procedures: one formula on the builder, two plus a repeat on the cleaner. */
function makeResult(sections: Record<string, string[]> = {
  [BUILDER]: ['The insert computes\n\n$$ TotalRevenue = sb.Qty \\times sb.UnitPrice $$\n\nat report load.'],
  [CLEANER]: [
    'Nulls become zero:\n\n$$OrderQty =\n  COALESCE(r.RawQty, 0)$$\n\nUnder `SUM` it aggregates: $$ OrderQty = COALESCE(SUM(r.RawQty), 0) $$',
    'Restating the same rule: $$ OrderQty = COALESCE(r.RawQty, 0) $$',
  ],
}): SmResult {
  return {
    status: 'complete',
    originNodeId: ORIGIN,
    fullNodes: [
      { id: ORIGIN, s: 'ai', n: 'factsalesreport', t: 'table' },
      { id: BUILDER, s: 'ai', n: 'spbuildsalesreport', t: 'procedure' },
      { id: CLEANER, s: 'ai', n: 'spcleanorders', t: 'procedure' },
    ],
    edges: [
      [BUILDER, ORIGIN, 'INSERT'],
      [CLEANER, BUILDER, 'SELECT'],
    ],
    detail_slots: Object.entries(sections).map(([nodeId, texts]) => ({
      nodeId,
      schema: 'ai',
      name: nodeId,
      type: 'procedure',
      sections: texts.map(text => ({ angle: 'business' as const, text })),
      summary: 's',
    })),
    node_states: [
      { nodeId: ORIGIN, action: 'passthrough', source: 'engine', reason: 'non_bodied_passthrough' },
      { nodeId: BUILDER, action: 'analyze', source: 'ai', reason: 'submitted_analyze' },
      { nodeId: CLEANER, action: 'analyze', source: 'ai', reason: 'submitted_analyze' },
    ],
    columnAspect: null,
  };
}

describe('Completion envelope — captured formulas are enumerated, not left in prose', () => {
  it('states every captured block once, keyed by the node whose slot holds it', () => {
    const reminder = buildSmCompletionEnvelope(makeResult(), QUESTION, []).synthesis_reminder;
    expect(reminder.includes(`- ${BUILDER} — $$ TotalRevenue = sb.Qty \\times sb.UnitPrice $$`),
      'the builder formula is listed under its own node').toBe(true);
    expect(reminder.includes(`- ${CLEANER} — $$ OrderQty = COALESCE(r.RawQty, 0) $$`),
      'the Qty formula T7 dropped is listed under its own node').toBe(true);
    expect(reminder.includes(`- ${CLEANER} — $$ OrderQty = COALESCE(SUM(r.RawQty), 0) $$`),
      'the SUM variant is a separate block, not a duplicate').toBe(true);
  });

  it('collapses a block written across lines to the inline form', () => {
    const reminder = buildSmCompletionEnvelope(makeResult(), QUESTION, []).synthesis_reminder;
    expect(reminder.includes('$$OrderQty =\n'), 'no line break survives inside a listed block').toBe(false);
  });

  it('lists a repeated block once per node', () => {
    const reminder = buildSmCompletionEnvelope(makeResult(), QUESTION, []).synthesis_reminder;
    const repeats = reminder.split('\n')
      .filter(line => line === `- ${CLEANER} — $$ OrderQty = COALESCE(r.RawQty, 0) $$`);
    expect(repeats, 'the same rule captured twice is one checklist entry').toHaveLength(1);
  });

  it('names the carry rule against the section that links the node', () => {
    const reminder = buildSmCompletionEnvelope(makeResult(), QUESTION, []).synthesis_reminder;
    expect(reminder.includes('Captured formulas (hop evidence).'), 'the checklist heading').toBe(true);
    expect(reminder.includes('a node you keep and link keeps its formulas too'),
      'the rule is stated where the blocks are listed, not only in the system prompt').toBe(true);
  });

  it('emits nothing when no hop captured a formula', () => {
    const reminder = buildSmCompletionEnvelope(
      makeResult({ [BUILDER]: ['The insert copies the staged value unchanged.'] }), QUESTION, [],
    ).synthesis_reminder;
    expect(reminder.includes('Captured formulas'),
      'an empty class adds no heading to the payload').toBe(false);
  });
});
