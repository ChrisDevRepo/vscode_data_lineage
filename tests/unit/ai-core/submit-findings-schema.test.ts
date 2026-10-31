// Owner: src/ai/tools/toolSchemas.ts (submitFindingsSchemaForMode); Zod/provider schema contracts.
/** Provider JSON Schema and runtime agree on fresh kept findings, cuts and held patches. */
import Ajv from 'ajv/dist/2020';
import { validateToolCandidate } from '../../../src/ai/support/toolValidation';
import { assert, describe, expect, it } from 'vitest';
import { submitFindingsSchemaForMode } from '../../../src/ai/tools/toolSchemas';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';

describe('fresh kept required-field projection', () => {
  it('requires a procedure out_node at both submission boundaries', () => {
    const schema = submitFindingsSchemaForMode('ct', 'technical', true, {
      outCols: ['Value'],
      outNode: true,
      columnSourceNodeIds: ['input'],
    });
    const wire = new Ajv({ strict: false }).compile(toModelJsonSchema(schema));
    const projected = JSON.stringify(toModelJsonSchema(schema));
    expect(projected).toContain(
      '"required":["out_col","upstream_columns","out_node"]',
    );
    for (const destination of [{}, { out_node: null }, { out_node: 'input' }]) {
      const omitted = !destination.out_node;
      const input = {
        focus_node_id: 'procedure',
        summary: 'SQL produces Value.',
        sections: {
          technical:
            'Recorded SQL findings; destination relationships are retained separately.',
        },
        column_flow: [
          {
            out_col: 'Value',
            upstream_columns: [{ node: 'input', col: 'Value' }],
            ...destination,
          },
        ],
      };
      const parsed = validateToolCandidate(schema, input);
      expect(parsed.success, JSON.stringify(destination)).toBe(!omitted);
      if (!omitted) {
        assert(parsed.success);
        expect(parsed.data).toEqual(input);
      }
      expect(wire(input), JSON.stringify(destination)).toBe(!omitted);
    }
  });

  it('requires CT flow and summary when no content is held', () => {
    // A fresh finding must supply its required fields.
    const served = submitFindingsSchemaForMode('ct', 'both', true);
    const wire = new Ajv({ strict: false }).compile(toModelJsonSchema(served));
    const held = {
      focus_node_id: 'source',
      summary: 'Held summary.',
      sections: { business: 'Held rule.', technical: 'Held mechanics.' },
      column_flow: [],
    };
    const corrections = [
      { summary: 'Corrected summary.' },
      {
        sections: { business: 'Held rule.', technical: 'Corrected mechanics.' },
      },
      {
        questions: [
          { nodeId: 'neighbor', question: 'Establish its contribution.' },
        ],
      },
      {
        prune_neighbors: [
          { id: 'neighbor', reason: 'SQL shows no contribution.' },
        ],
      },
      { column_flow: [] },
    ];
    for (const correction of corrections) {
      const partial = { focus_node_id: 'source', ...correction };
      expect(validateToolCandidate(served, partial).success).toBe(false);
      expect(wire(partial)).toBe(false);
      const resend = { ...held, ...correction };
      expect(validateToolCandidate(served, resend).success).toBe(true);
      expect(wire(resend)).toBe(true);
    }
    for (const patch of [
      { ...held, extra: true },
      { ...held, questions: [{ nodeId: 'neighbor' }] },
    ]) {
      expect(validateToolCandidate(served, patch).success).toBe(false);
      expect(wire(patch)).toBe(false);
    }
  });
});

// Column-source notes use the same native bound for fresh and held corrections.
it('rejects a column-source note over 200 characters and accepts the repaired note', () => {
  for (const schema of [
    submitFindingsSchemaForMode('ct', 'business'),
    submitFindingsSchemaForMode('ct', 'business', false),
  ]) {
    const value = (length: number) => ({
      summary: 'Recorded findings.',
      column_flow: [
        {
          out_col: 'Value',
          upstream_columns: [
            { node: '[dbo].[Source]', col: 'Value', note: 'x'.repeat(length) },
          ],
        },
      ],
    });
    expect(validateToolCandidate(schema, value(201)).success).toBe(false);
    expect(validateToolCandidate(schema, value(200)).success).toBe(true);
  }
});
