import { describe, expect, it } from 'vitest';
import { buildSmCompletionEnvelope, buildSmProtocol } from '../../../src/ai/prompting/smPrompts';
import { submitFindingsSchemaForMode } from '../../../src/ai/tools/toolSchemas';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';
import type { SmResult } from '../../../src/ai/sm/smTypes';

/**
 * CT ⊇ BB, asserted as containment rather than as a list of hand-picked phrases.
 *
 * The prior pins named individual sentences, so a CT paraphrase could replace a BB rule the pin
 * did not happen to name — which is how a CT-only verdict menu shipped alongside BB's. These tests
 * take every sentence the BB surface renders and require the CT surface to carry it verbatim, so a
 * CT edit that drops or rewords one fails here without anyone having predicted which one.
 */

/**
 * Sentences of one rendered surface. Split per LINE first, then per sentence within the line: a
 * flat split would fuse a heading with the line under it, and the two surfaces order their blocks
 * differently, so a fused pair would compare unequal for a reason that is not a dropped rule.
 */
function sentences(text: string): string[] {
  return text
    .split('\n')
    .flatMap(line => line.trim().split(/(?<=[.!?])\s+(?=[A-Z"`(*#[-])/))
    .map(s => s.trim())
    .filter(s => s.length > 15);
}

/** Four-node fixture shared by both reminder renders; CT adds the column aspect and nothing else. */
function makeResult(columnAspect: SmResult['columnAspect']): SmResult {
  return {
    status: 'complete',
    originNodeId: '[dbo].[origina]',
    fullNodes: [
      { id: '[dbo].[origina]', s: 'dbo', n: 'origina', t: 'view' },
      { id: '[dbo].[sploada]', s: 'dbo', n: 'sploada', t: 'procedure' },
      { id: '[dbo].[stagea]', s: 'dbo', n: 'stagea', t: 'table' },
      { id: '[dbo].[rawa]', s: 'dbo', n: 'rawa', t: 'table' },
    ],
    edges: [
      ['[dbo].[sploada]', '[dbo].[origina]', 'INSERT'],
      ['[dbo].[stagea]', '[dbo].[sploada]', 'SELECT'],
      ['[dbo].[rawa]', '[dbo].[stagea]', 'SELECT'],
    ],
    detail_slots: [{
      nodeId: '[dbo].[sploada]',
      schema: 'dbo',
      name: 'sploada',
      type: 'procedure',
      sections: [{ angle: 'business', text: 'Nets the line: $$ NetAmountA = QtyA \\times PriceA $$' }],
      summary: 's',
    }],
    node_states: [{ nodeId: '[dbo].[sploada]', action: 'analyze', source: 'ai', reason: 'submitted_analyze' }],
    columnAspect,
  } as SmResult;
}

describe('BB/CT instruction parity — CT is BB plus columns', () => {
  it('renders every BB protocol sentence inside the CT protocol', () => {
    const bb = buildSmProtocol({ classification: 'business' });
    const ct = buildSmProtocol({ classification: 'business', targetColumns: ['TotalRevenue'] });

    const missing = sentences(bb).filter(sentence => !ct.includes(sentence));
    expect(missing, 'CT drops or rewords a BB instruction instead of adding to it').toEqual([]);
    expect(ct.length, 'CT adds the column aspect').toBeGreaterThan(bb.length);
  });

  it('renders every BB synthesis-reminder sentence inside the CT reminder for one fixture', () => {
    const bb = buildSmCompletionEnvelope(makeResult(null), 'What feeds NetAmountA?', []).synthesis_reminder;
    const ct = buildSmCompletionEnvelope(makeResult({
      target_columns: ['NetAmountA'],
      edges: [{
        from_node: '[dbo].[stagea]', from_col: 'AmountA',
        to_node: '[dbo].[origina]', to_col: 'NetAmountA',
        hop: 1, hop_node: '[dbo].[sploada]',
      }],
    } as SmResult['columnAspect']), 'What feeds NetAmountA?', []).synthesis_reminder;

    const missing = sentences(bb).filter(sentence => !ct.includes(sentence));
    expect(missing, 'the CT reminder drops a BB synthesis instruction or engine fact').toEqual([]);
  });

  it('states the verdict definitions once, with CT adding the column clause', () => {
    const describeVerdict = (mode: 'bb' | 'ct'): string => {
      const projected = toModelJsonSchema(submitFindingsSchemaForMode(mode)) as {
        properties?: Record<string, { description?: string }>;
      };
      return projected.properties?.verdict?.description ?? '';
    };
    const bb = describeVerdict('bb');
    const ct = describeVerdict('ct');

    expect(bb, 'the BB verdict description is rendered').not.toBe('');
    expect(ct.startsWith(bb), 'the CT description is BB\'s text plus its column clause').toBe(true);
    expect(ct.slice(bb.length)).toContain('column_flow');
  });
});
