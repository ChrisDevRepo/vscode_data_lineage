// Owner: src/ai/tools/toolSchemas.ts (submitFindingsSchemaForMode); Zod/provider schema contracts.
/** Provider JSON Schema and runtime agree on fresh kept findings, cuts and held patches. */
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { SubmitFindingsCtInputSchema, submitFindingsSchemaForMode } from '../../../src/ai/tools/toolSchemas';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';

describe('fresh kept required-field projection', () => {
  it('keeps procedure destinations optional and nullable at both submission boundaries', () => {
    const schema = submitFindingsSchemaForMode('ct', 'technical', true, {
      outCols: ['Value'], writesTo: true, columnSourceNodeIds: ['input'],
    });
    const wire = new Ajv({ strict: false }).compile(toModelJsonSchema(schema));
    for (const destination of [{}, { writes_to: null }, { writes_to: { node: 'stored', col: 'Value' } }]) {
      const input = { focus_node_id: 'procedure', summary: 'SQL produces Value.',
        sections: { technical: 'Recorded SQL findings; destination relationships are retained separately.' },
        column_flow: [{ out_col: 'Value', upstream_columns: [{ node: 'input', col: 'Value' }], ...destination }] };
      const parsed = schema.safeParse(input);
      expect(parsed.success, JSON.stringify(destination)).toBe(true);
      if (parsed.success) expect(parsed.data).toEqual(input);
      expect(wire(input), JSON.stringify(destination)).toBe(true);
    }
  });

  it.each([
    { cs: false, raw: ' sales . source ', accepted: true },
    { cs: true, raw: ' "Sales" . "Source" ', accepted: true },
    { cs: true, raw: 'sales.source', accepted: false },
    { cs: false, raw: 'Source', accepted: false },
    { cs: false, raw: 'Sales..Source', accepted: false },
    { cs: false, raw: 'server.db.Sales.Source', accepted: false },
  ])('binds only metadata-equivalent action, contributor and scalar IDs: $raw CS=$cs', ({ cs, raw, accepted }) => {
    const canonical = '[Sales].[Source]';
    const hop = { outCols: ['Value'], writesTo: false, identifierCaseSensitive: cs,
      neighbors: [{ id: canonical, can_question: true, can_prune: true }],
      columnSourceNodeIds: [canonical], incomingRefs: [{ node: canonical, col: 'Value' }],
    };
    for (const part of [
      { questions: [{ nodeId: raw, question: 'Establish Value.' }] },
      { prune_neighbors: [{ id: raw, reason: 'Not needed.' }] },
      { column_flow: [{ out_col: 'Value', upstream_columns: [{ node: raw, col: 'Value' }] }] },
      { terminated_inputs: [{ node: raw, col: 'Value' }] },
    ]) {
      const input = { focus_node_id: 'focus', column_flow: [], ...part };
      const parsed = submitFindingsSchemaForMode('ct', undefined, false, hop).safeParse(input);
      expect(parsed.success).toBe(accepted);
      if (parsed.success) expect(parsed.data).toEqual(input);
    }
    const input = { focus_node_id: 'focus', column_flow: [{ out_col: 'Value', upstream_columns: [], returns_to: { node: raw, col: 'Value' } }] };
    const scalar = submitFindingsSchemaForMode('ct', undefined, false, { ...hop, returnTargets: [{ node: canonical, col: 'Value' }] }).safeParse(input);
    expect(scalar.success).toBe(accepted);
    if (scalar.success) expect(scalar.data).toEqual(input);
  });

  it.each(['bb', 'ct'] as const)('serves an empty neighbor choice set safely in %s', mode => {
    const schema = submitFindingsSchemaForMode(mode, undefined, false, { outCols: null, writesTo: false, neighbors: [] });
    const wire = new Ajv({ strict: false }).compile(toModelJsonSchema(schema));
    const input = { focus_node_id: 'focus', ...(mode === 'ct' ? { column_flow: [] } : {}), questions: [], prune_neighbors: [] };
    expect(schema.safeParse(input).success).toBe(true);
    expect(wire(input)).toBe(true);
    expect(wire({ ...input, questions: [{ nodeId: 'unknown', question: 'Check it.' }] })).toBe(false);
  });

  it.each(['bb', 'ct'] as const)('uses the same hop neighbor choices for model and runtime in %s', mode => {
    const schema = submitFindingsSchemaForMode(mode, undefined, false, {
      outCols: null, writesTo: false,
      neighbors: [{ id: 'open', can_question: true, can_prune: true },
        { id: 'queued', can_question: true, can_prune: false },
        { id: 'visited', can_question: false, can_prune: false }],
    });
    const wire = new Ajv({ strict: false }).compile(toModelJsonSchema(schema));
    for (const id of ['open', 'queued', 'visited', 'distant']) {
      for (const prune of [false, true]) {
        const input = { focus_node_id: 'focus', ...(mode === 'ct' ? { column_flow: [] } : {}),
          ...(prune ? { prune_neighbors: [{ id, reason: 'Off path.' }] } : { questions: [{ nodeId: id, question: 'Check it.' }] }) };
        const accepted = id === 'open' || (!prune && id === 'queued');
        expect(schema.safeParse(input).success, `${id} prune=${prune}`).toBe(accepted);
        expect(wire(input), `${id} prune=${prune}`).toBe(accepted);
      }
    }
  });

  it.each([
    { caseSensitive: false, name: ' value ', accepted: true },
    { caseSensitive: true, name: ' Value ', accepted: true },
    { caseSensitive: true, name: ' value ', accepted: false },
    { caseSensitive: false, name: '[Value]', accepted: true },
    { caseSensitive: true, name: '"Value"', accepted: true },
    { caseSensitive: false, name: 'LTRIM(Value)', accepted: false },
  ])('uses column comparison consistently for $name under caseSensitive=$caseSensitive', ({ caseSensitive, name, accepted }) => {
    for (const scalar of [false, true]) {
      const schema = submitFindingsSchemaForMode('ct', undefined, false, {
        outCols: ['Value'], writesTo: false, identifierCaseSensitive: caseSensitive,
        incomingRefs: [{ node: 'source', col: 'Value' }],
        ...(scalar ? { returnTargets: [{ node: 'caller', col: 'Value' }] } : {}),
      });
      const input = { focus_node_id: 'focus', column_flow: [{ out_col: name, upstream_columns: [],
        ...(scalar ? { returns_to: { node: 'caller', col: name } } : {}) }],
        terminated_inputs: [{ node: 'source', col: name }] };
      const before = structuredClone(input);
      const parsed = schema.safeParse(input);
      expect(parsed.success).toBe(accepted);
      if (parsed.success) expect(parsed.data).toEqual(before);
      expect(input).toEqual(before);
      expect(schema.safeParse({ ...input, terminated_inputs: [{ node: 'SOURCE', col: name }] }).success).toBe(accepted && !caseSensitive);
    }
  });

  it('projects fresh requirements directly without composition or changing held schemas', () => {
    const fresh = toModelJsonSchema(submitFindingsSchemaForMode('ct', 'both', true));
    const held = toModelJsonSchema(submitFindingsSchemaForMode('ct', 'both', false));
    expect(fresh).not.toHaveProperty('if');
    expect(fresh).not.toHaveProperty('then');
    expect(fresh).not.toHaveProperty('anyOf');
    expect(fresh.required).toEqual(expect.arrayContaining(['focus_node_id', 'column_flow', 'summary', 'sections']));
    expect((fresh.properties as any).sections.required).toEqual(['business', 'technical']);
    const props = fresh.properties as any;
    expect(props).not.toHaveProperty('verdict');
    expect(props).not.toHaveProperty('reason');
    expect(props.prune_neighbors.description).toContain('dead end');
    expect(held).not.toHaveProperty('anyOf');
    expect(held).not.toHaveProperty('if');
    expect(held).not.toHaveProperty('then');
  });

  it.each(['bb', 'ct'] as const)('rejects missing fresh kept fields at both boundaries in %s', mode => {
    const schema = submitFindingsSchemaForMode(mode, 'technical', true);
    const wire = new Ajv({ strict: false }).compile(toModelJsonSchema(schema));
    const accepted = { focus_node_id: 'source', summary: 'Supplies the amount.',
      sections: { technical: 'Amount is supplied unchanged.' }, ...(mode === 'ct' ? { column_flow: [] } : {}) };
    expect(schema.safeParse(accepted).success).toBe(true);
    expect(wire(accepted)).toBe(true);
    for (const missing of ['summary', 'sections'] as const) {
      const invalid: Record<string, unknown> = { ...accepted };
      delete invalid[missing];
      expect(schema.safeParse(invalid).success).toBe(false);
      expect(wire(invalid), `${missing} must be advertised as required for a fresh finding`).toBe(false);
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
      const input = { focus_node_id: 'source', summary: 'Supplies the amount.', column_flow: [], sections };
      const before = structuredClone(input);
      expect(wire(input)).toBe(Object.keys(sections).length > 0);
      expect(schema.safeParse(input).success).toBe(Object.keys(sections).length > 0);
      expect(input).toEqual(before);
    }
  });

  it.each(['business', 'technical', 'both'] as const)('rejects obsolete verdicts and keeps a fully pruned focus under %s', classification => {
    const schema = submitFindingsSchemaForMode('ct', classification, true);
    const wire = new Ajv({ strict: false }).compile(toModelJsonSchema(schema));
    const deadEnd = { focus_node_id: 'unrelated', summary: 'Stops here.',
      column_flow: [], sections: classification === 'business'
        ? { business: 'Nothing continues.' }
        : classification === 'technical'
          ? { technical: 'Nothing continues.' }
          : { business: 'Nothing continues.', technical: 'Nothing continues.' },
      prune_neighbors: [{ id: 'next', reason: 'Off the path.' }] };
    expect(schema.safeParse(deadEnd).success).toBe(true);
    expect(wire(deadEnd)).toBe(true);
    for (const obsolete of [{ verdict: 'analyze' }, { verdict: 'passthrough' }, { verdict: 'end_branch' }, { reason: 'Unused legacy field.' }]) {
      expect(schema.safeParse({ ...deadEnd, ...obsolete }).success).toBe(false);
      expect(wire({ ...deadEnd, ...obsolete })).toBe(false);
    }
  });

  it.each(['', '   '])('rejects an explicitly blank repair summary %j instead of retaining an older summary silently', summary => {
    const schema = submitFindingsSchemaForMode('ct', 'technical', false);
    expect(schema.safeParse({ focus_node_id: 'source', summary, column_flow: [] }).success).toBe(false);
    expect(schema.safeParse({ focus_node_id: 'source', column_flow: [] }).success).toBe(true);
  });

  it('accepts held patches without resending held content', () => {
    const schema = submitFindingsSchemaForMode('ct', 'both', false);
    const wire = new Ajv({ strict: false }).compile(toModelJsonSchema(schema));
    const patch = { focus_node_id: 'source', column_flow: [] };
    expect(schema.safeParse(patch).success).toBe(true);
    expect(wire(patch)).toBe(true);
    const oneAngle = { ...patch, sections: { technical: 'Corrected mechanics.' } };
    expect(schema.safeParse(oneAngle).success).toBe(true);
    expect(wire(oneAngle)).toBe(true);
  });

  it('admits only corrections when a valid CT flow is held in both provider and runtime schemas', () => {
    const held = submitFindingsSchemaForMode('ct', 'both', false, undefined, true);
    const unheld = submitFindingsSchemaForMode('ct', 'both', false);
    const ajv = new Ajv({ strict: false });
    const wire = ajv.compile(toModelJsonSchema(held));
    const unheldWire = ajv.compile(toModelJsonSchema(unheld));
    const envelope = { focus_node_id: 'source' };
    const corrections = [
      { summary: 'Corrected summary.' },
      { sections: { technical: 'Corrected mechanics.' } },
      { questions: [{ nodeId: 'neighbor', question: 'Establish its contribution.' }] },
      { prune_neighbors: [{ id: 'neighbor', reason: 'SQL shows no contribution.' }] },
      { terminated_inputs: [{ node: 'upstream', col: 'Value' }] },
    ];
    for (const correction of corrections) {
      const patch = { ...envelope, ...correction };
      expect(held.safeParse(patch).success).toBe(true);
      expect(wire(patch)).toBe(true);
      expect(unheld.safeParse(patch).success).toBe(false);
      expect(unheldWire(patch)).toBe(false);
    }
    for (const patch of [{ ...envelope, column_flow: [] }, { ...envelope, terminated_inputs: [] }]) {
      expect(held.safeParse(patch).success).toBe(true);
      expect(wire(patch)).toBe(true);
    }
    for (const patch of [{ ...envelope, extra: true }, { ...envelope, questions: [{ nodeId: 'neighbor' }] }]) {
      expect(held.safeParse(patch).success).toBe(false);
      expect(wire(patch)).toBe(false);
    }
  });

  it.each(['bb', 'ct'] as const)('requires both fresh locked angles without changing input or contaminating a held schema in %s', mode => {
    const held = submitFindingsSchemaForMode(mode, 'both', false);
    const fresh = submitFindingsSchemaForMode(mode, 'both', true);
    expect(fresh).not.toBe(held);
    expect(submitFindingsSchemaForMode(mode, 'both', false)).toBe(held);
    const wire = new Ajv({ strict: false }).compile(toModelJsonSchema(fresh));
    for (const sections of [{ business: 'Business rule.' }, { technical: 'Execution rule.' }]) {
      const partial = { focus_node_id: 'source', summary: 'Supplies the amount.', ...(mode === 'ct' ? { column_flow: [] } : {}), sections };
      const before = structuredClone(partial);
      expect(fresh.safeParse(partial).success).toBe(false);
      expect(wire(partial)).toBe(false);
      expect(held.safeParse(partial).success).toBe(true);
      expect(new Ajv({ strict: false }).compile(toModelJsonSchema(held))(partial)).toBe(true);
      expect(partial).toEqual(before);
    }
    const complete = { focus_node_id: 'source', summary: 'Supplies the amount.',
      ...(mode === 'ct' ? { column_flow: [] } : {}), sections: { business: 'Business rule.', technical: 'Execution rule.' } };
    expect(fresh.safeParse(complete).success).toBe(true);
    expect(wire(complete)).toBe(true);
  });

  it.each(['bb', 'ct'] as const)('honours a held submission without a classification in %s', mode => {
    const held = submitFindingsSchemaForMode(mode, undefined, false);
    const fresh = submitFindingsSchemaForMode(mode, undefined, true);
    expect(held).not.toBe(fresh);
    expect(submitFindingsSchemaForMode(mode, undefined, false)).toBe(held);
    const patch = { focus_node_id: 'source', ...(mode === 'ct' ? { column_flow: [] } : {}) };
    expect(held.safeParse(patch).success).toBe(true);
    expect(fresh.safeParse(patch).success).toBe(false);
  });
});
