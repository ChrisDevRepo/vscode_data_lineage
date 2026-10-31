/** Owns toolSchemas.ts presentation shape, JSON Schema projection and report-label constraints. */
import Ajv from 'ajv/dist/2020';
import { validateToolCandidate } from '../../../src/ai/support/toolValidation';
import { describe, expect, it } from 'vitest';
import {
  PresentResultModelSchema,
  presentResultSchemaForPhase,
} from '../../../src/ai/tools/toolSchemas';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';

const nodeId = '[dbo].[Result]';

function resultWith(highlightGroups: unknown) {
  return {
    name: 'Result lineage',
    summary: 'Shows how the result is produced.',
    highlight_groups: highlightGroups,
    sections: [
      { label: 'Result', node_ids: [nodeId], text: 'The requested result.' },
    ],
  };
}

describe('present-result schema and provider contract', () => {
  it('delivers every structurally valid group without a group-count cap', () => {
    const highlightGroups = Array.from({ length: 6 }, (_, index) => ({
      label: `Group ${index + 1}`,
      color: index % 2 === 0 ? 'source' : 'transform',
      node_ids: [nodeId],
    }));

    const parsed = PresentResultModelSchema.parse(resultWith(highlightGroups));

    expect(parsed.highlight_groups).toHaveLength(6);
    expect(parsed.highlight_groups.map((group) => group.label)).toEqual(
      highlightGroups.map((group) => group.label),
    );
  });

  it('accepts long section labels unchanged in final reports and repairs', () => {
    const text = 'x'.repeat(2000);
    const input = {
      ...resultWith([
        { label: 'Sources', color: 'source', node_ids: [nodeId] },
      ]),
      name: 'Result',
      title: 'Report',
    };
    const wire = new Ajv({ strict: false }).compile(
      toModelJsonSchema(PresentResultModelSchema),
    );
    expect(PresentResultModelSchema.parse(input)).toEqual(input);
    expect(wire(input)).toBe(true);
    const badge = {
      ...input,
      sections: [{ label: 'x'.repeat(91), node_ids: [nodeId], text }],
    };
    expect(PresentResultModelSchema.parse(badge)).toEqual(badge);
    expect(wire(badge)).toBe(true);
  });

  // Native presentation limits preserve long section labels.
  it.each([
    ['name', 90],
    ['title', 120],
    ['legend', 60],
  ] as const)(
    'enforces the %s bound and accepts its repaired value',
    (field, max) => {
      const value = (length: number) => ({
        ...resultWith([
          {
            label: field === 'legend' ? 'x'.repeat(length) : 'Sources',
            color: 'source',
            node_ids: [nodeId],
          },
        ]),
        name: field === 'name' ? 'x'.repeat(length) : 'Result',
        title: field === 'title' ? 'x'.repeat(length) : 'Report',
      });
      for (const schema of [
        PresentResultModelSchema,
        presentResultSchemaForPhase('synthesis'),
      ]) {
        expect(validateToolCandidate(schema, value(max + 1)).success).toBe(
          false,
        );
        expect(validateToolCandidate(schema, value(max)).success).toBe(true);
      }
    },
  );
});
