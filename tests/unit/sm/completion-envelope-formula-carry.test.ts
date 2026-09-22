/**
 * Every mandatory-carry class at synthesis is enumerated; formulas must be too, not left buried
 * in slot prose where synthesis can drop them while still enumerating node ids as a checklist.
 * The envelope states the captured blocks in the same shape, keyed by node.
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
      'the Qty formula is listed under its own node').toBe(true);
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

/** A hop that captured its evidence as SQL rather than as `$$` — fenced body plus inline spans. */
const SQL_CAPTURE = [
  'The load step:\n\n```sql\nTRUNCATE TABLE ai.staging;\nINSERT INTO ai.staging (col_a, col_b)\nSET col_a = COALESCE(src.amount, 0)\n```\n\n'
  + 'The guard is `COALESCE(src.amount, 0)`, applied once per `batch`, and `COALESCE(src.amount, 0)` again downstream.',
];

describe('Completion envelope — the checklist enumerates what computes a value', () => {
  const rowsFor = (nodeId: string): string[] => buildSmCompletionEnvelope(
    makeResult({ [nodeId]: SQL_CAPTURE }), QUESTION, [],
  ).synthesis_reminder.split('\n').filter(line => line.startsWith(`- ${nodeId} — `));

  it('enumerates a fenced line that carries a call token', () => {
    expect(rowsFor(BUILDER), 'the assignment computing a value is listed in the form it was captured')
      .toContain(`- ${BUILDER} — \`\`\` SET col_a = COALESCE(src.amount, 0) \`\`\``);
  });

  it('leaves a whole statement out of the checklist', () => {
    const rows = rowsFor(BUILDER).join('\n');
    expect(rows.includes('TRUNCATE TABLE'), 'an action with no call token is not evidence of a value').toBe(false);
    expect(rows.includes('INSERT INTO'), 'a statement with a call token is still an action, not a value').toBe(false);
  });

  it('enumerates an inline span that computes a value and skips a bare name', () => {
    const rows = rowsFor(BUILDER);
    expect(rows, 'the inline expression is carried like any other formula')
      .toContain(`- ${BUILDER} — \`COALESCE(src.amount, 0)\``);
    expect(rows.includes(`- ${BUILDER} — \`batch\``), 'a backticked name is a name, not a computation').toBe(false);
  });

  it('lists a repeated expression once and renders byte-identically across builds', () => {
    const first = rowsFor(BUILDER);
    expect(first.filter(row => row === `- ${BUILDER} — \`COALESCE(src.amount, 0)\``),
      'the same expression captured twice is one checklist entry').toHaveLength(1);
    expect(rowsFor(BUILDER).join('\n'), 'the block is stable across builds').toBe(first.join('\n'));
  });
});

/** A hop that captured its filter logic as SQL — a fenced WHERE line plus an inline JOIN condition. */
const PREDICATE_CAPTURE = [
  'The extract step:\n\n```sql\nINSERT INTO ai.staging (col_a)\nWHERE e.IsValid = 1\n```\n\n'
  + 'Joined via `ON a.CustomerID = b.CustomerID`, keyed by `batch`.',
];

describe('Completion envelope — the checklist enumerates what filters rows', () => {
  const rowsFor = (nodeId: string): string[] => buildSmCompletionEnvelope(
    makeResult({ [nodeId]: PREDICATE_CAPTURE }), QUESTION, [],
  ).synthesis_reminder.split('\n').filter(line => line.startsWith(`- ${nodeId} — `));

  it('enumerates a fenced line that opens a predicate', () => {
    expect(rowsFor(BUILDER), 'the filter condition is listed in the form it was captured')
      .toContain(`- ${BUILDER} — \`\`\` WHERE e.IsValid = 1 \`\`\``);
  });

  it('enumerates an inline span that opens a join condition', () => {
    expect(rowsFor(BUILDER), 'the join predicate is carried like any other filter')
      .toContain(`- ${BUILDER} — \`ON a.CustomerID = b.CustomerID\``);
  });

  it('leaves a whole statement out of the checklist', () => {
    const rows = rowsFor(BUILDER).join('\n');
    expect(rows.includes('INSERT INTO'), 'an action with no call token or predicate opener is not a filter').toBe(false);
  });

  it('skips a bare backticked name that opens neither a call nor a predicate', () => {
    expect(rowsFor(BUILDER).includes(`- ${BUILDER} — \`batch\``), 'a name is neither a computation nor a filter').toBe(false);
  });
});
