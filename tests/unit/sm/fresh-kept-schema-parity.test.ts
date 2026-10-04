/** Provider JSON Schema and runtime agree on fresh kept findings, cuts and held patches. */
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { SubmitFindingsCtInputSchema, submitFindingsSchemaForMode } from '../../../src/ai/tools/toolSchemas';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';

describe('fresh kept required-field projection', () => {
  it.each(['bb', 'ct'] as const)('preserves the previous fresh accepted set across classifications and malformed inputs in %s', mode => {
    for (const classification of ['business', 'technical', 'both'] as const) {
      const projected = toModelJsonSchema(submitFindingsSchemaForMode(mode, classification, true));
      const previous = structuredClone(projected) as any;
      const angles = classification === 'both' ? ['business', 'technical'] : [classification];
      previous.required = previous.required.filter((key: string) => key !== 'summary' && key !== 'sections');
      delete previous.properties.sections.required;
      previous.anyOf = [{ properties: { verdict: { enum: ['analyze', 'passthrough'] }, sections: { required: angles } }, required: ['verdict', 'summary', 'sections'] }];
      const ajv = new Ajv({ strict: false });
      const before = ajv.compile(previous), after = ajv.compile(projected);
      const complete: Record<string, unknown> = { focus_node_id: 'source', verdict: 'analyze', summary: 'Observed rule.', sections: Object.fromEntries(angles.map(angle => [angle, 'Observed rule.'])), ...(mode === 'ct' ? { column_flow: [] } : {}) };
      const examples: unknown[] = [complete, null, [], {}, { ...complete, verdict: 'end_branch' }, { ...complete, verdict: 'passthrough' }, { ...complete, sections: {} }, { ...complete, sections: { business: 'Only business.' } }, { ...complete, sections: { technical: 'Only technical.' } }, { ...complete, sections: { ...complete.sections as object, other: 'Unknown angle.' } }, { ...complete, summary: null }, { ...complete, questions: [{ nodeId: 'neighbor' }] }, { ...complete, prune_neighbors: [{}] }, { ...complete, extra: true }];
      for (const key of Object.keys(complete)) {
        const missing = { ...complete }; delete missing[key]; examples.push(missing);
      }
      for (const example of examples) {
        expect(after(example), JSON.stringify(example)).toBe(before(example));
      }
    }
  });

  it('projects fresh requirements directly without composition or changing held schemas', () => {
    const fresh = toModelJsonSchema(submitFindingsSchemaForMode('ct', 'both', true));
    const held = toModelJsonSchema(submitFindingsSchemaForMode('ct', 'both', false));
    expect(fresh).not.toHaveProperty('if');
    expect(fresh).not.toHaveProperty('then');
    expect(fresh).not.toHaveProperty('anyOf');
    expect(fresh.required).toEqual(expect.arrayContaining(['focus_node_id', 'verdict', 'column_flow', 'summary', 'sections']));
    expect((fresh.properties as any).sections.required).toEqual(['business', 'technical']);
    const props = fresh.properties as any;
    expect(JSON.stringify(props.verdict.enum)).toBe(JSON.stringify(['analyze', 'passthrough']));
    expect(props.prune_neighbors.description).toContain('dead end');
    expect(held).not.toHaveProperty('anyOf');
    expect(held).not.toHaveProperty('if');
    expect(held).not.toHaveProperty('then');
  });

  it.each(['bb', 'ct'] as const)('rejects missing fresh kept fields at both boundaries in %s', mode => {
    const schema = submitFindingsSchemaForMode(mode, 'technical', true);
    const wire = new Ajv({ strict: false }).compile(toModelJsonSchema(schema));
    const accepted = { focus_node_id: 'source', verdict: 'analyze', summary: 'Supplies the amount.',
      sections: { technical: 'Amount is supplied unchanged.' }, ...(mode === 'ct' ? { column_flow: [] } : {}) };
    expect(schema.safeParse(accepted).success).toBe(true);
    expect(wire(accepted)).toBe(true);
    for (const missing of ['summary', 'sections'] as const) {
      const invalid: Record<string, unknown> = { ...accepted };
      delete invalid[missing];
      expect(schema.safeParse(invalid).success).toBe(false);
      expect(wire(invalid), `${missing} must be advertised as required for a fresh kept verdict`).toBe(false);
    }
    const missingAngle = { ...accepted, sections: {} };
    expect(schema.safeParse(missingAngle).success).toBe(false);
    expect(wire(missingAngle)).toBe(false);
  });

  it('requires an authored angle without a classification lock and preserves input identity', () => {
    const schema = SubmitFindingsCtInputSchema;
    const projected = toModelJsonSchema(schema);
    expect(JSON.stringify(projected)).not.toContain('minProperties');
    const wire = new Ajv({ strict: false }).compile(projected);
    for (const sections of [{}, { business: 'Business rule.' }, { technical: 'Execution rule.' }]) {
      const input = { focus_node_id: 'source', verdict: 'analyze', summary: 'Supplies the amount.', column_flow: [], sections };
      const before = structuredClone(input);
      expect(wire(input)).toBe(Object.keys(sections).length > 0);
      expect(schema.safeParse(input).success).toBe(Object.keys(sections).length > 0);
      expect(input).toEqual(before);
    }
  });

  it.each(['business', 'technical', 'both'] as const)('rejects end_branch and keeps a fully pruned focus under %s', classification => {
    const schema = submitFindingsSchemaForMode('ct', classification, true);
    const wire = new Ajv({ strict: false }).compile(toModelJsonSchema(schema));
    const cut = { focus_node_id: 'unrelated', verdict: 'end_branch', reason: 'Off the requested path.',
      column_flow: [], sections: {} };
    expect(schema.safeParse(cut).success).toBe(false);
    expect(wire(cut)).toBe(false);
    const deadEnd = { focus_node_id: 'unrelated', verdict: 'analyze', summary: 'Stops here.',
      column_flow: [], sections: classification === 'business'
        ? { business: 'Nothing continues.' }
        : classification === 'technical'
          ? { technical: 'Nothing continues.' }
          : { business: 'Nothing continues.', technical: 'Nothing continues.' },
      prune_neighbors: [{ id: 'next', reason: 'Off the path.' }] };
    expect(schema.safeParse(deadEnd).success).toBe(true);
    expect(wire(deadEnd)).toBe(true);
  });

  it.each(['analyze', 'passthrough'] as const)('accepts %s held patches without resending held content', verdict => {
    const schema = submitFindingsSchemaForMode('ct', 'both', false);
    const wire = new Ajv({ strict: false }).compile(toModelJsonSchema(schema));
    const patch = { focus_node_id: 'source', verdict, column_flow: [] };
    expect(schema.safeParse(patch).success).toBe(true);
    expect(wire(patch)).toBe(true);
    const oneAngle = { ...patch, sections: { technical: 'Corrected mechanics.' } };
    expect(schema.safeParse(oneAngle).success).toBe(true);
    expect(wire(oneAngle)).toBe(true);
  });

  it('requires both fresh locked angles without changing the authored input or contaminating a held schema', () => {
    const held = submitFindingsSchemaForMode('ct', 'both', false);
    const fresh = submitFindingsSchemaForMode('ct', 'both', true);
    expect(fresh).not.toBe(held);
    expect(submitFindingsSchemaForMode('ct', 'both', false)).toBe(held);
    const wire = new Ajv({ strict: false }).compile(toModelJsonSchema(fresh));
    for (const verdict of ['analyze', 'passthrough']) {
      for (const sections of [{ business: 'Business rule.' }, { technical: 'Execution rule.' }]) {
        const partial = { focus_node_id: 'source', verdict, summary: 'Supplies the amount.', column_flow: [], sections };
        const before = structuredClone(partial);
        expect(fresh.safeParse(partial).success).toBe(false);
        expect(wire(partial)).toBe(false);
        expect(held.safeParse(partial).success).toBe(true);
        expect(new Ajv({ strict: false }).compile(toModelJsonSchema(held))(partial)).toBe(true);
        expect(partial).toEqual(before);
      }
    }
    const complete = { focus_node_id: 'source', verdict: 'analyze', summary: 'Supplies the amount.',
      column_flow: [], sections: { business: 'Business rule.', technical: 'Execution rule.' } };
    expect(fresh.safeParse(complete).success).toBe(true);
    expect(wire(complete)).toBe(true);
  });
});
