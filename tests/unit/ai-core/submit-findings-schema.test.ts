// Owner: src/ai/tools/toolSchemas.ts (submitFindingsSchemaForMode); Zod/provider schema contracts.
/** Provider JSON Schema and runtime agree on fresh kept findings, cuts and held patches. */
import Ajv from 'ajv/dist/2020';
import { validateToolCandidate } from '../../../src/ai/support/toolValidation';
import { schemaFaults, withSchemaFaults } from './helpers/toolServices';
import { describe, expect, it, vi } from 'vitest';
import { SubmitFindingsCtInputSchema, submitFindingsSchemaForMode, findingAdmissionFacts } from '../../../src/ai/tools/toolSchemas';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';
import { normalizeModelInput } from '../../../src/ai/tools/normalizeModelInput';

const findingFields = (input: unknown, schema: Parameters<typeof findingAdmissionFacts>[0]) => {
  const facts = findingAdmissionFacts(schema);
  expect(validateToolCandidate(schema, input, facts.facts).success).toBe(false);
  return facts;
};

describe('fresh kept required-field projection', () => {
  it.each([
    { caseSensitive: true, reference: 'dbo.Source', ambiguous: false, accepted: true },
    { caseSensitive: true, reference: 'dbo.source', ambiguous: false, accepted: false },
    { caseSensitive: false, reference: 'dbo.SOURCE', ambiguous: true, accepted: false },
    { caseSensitive: false, reference: 'dbo.Missing', ambiguous: false, accepted: false },
  ])('preserves source-policy refusal at the normalized provider boundary: %j', row => {
    const ids = ['[dbo].[Source]', ...(row.ambiguous ? ['[DBO].[source]'] : [])];
    const schema = submitFindingsSchemaForMode('ct', 'technical', false, {
      outCols: ['Value'], writesTo: false, columnSourceNodeIds: ids,
      identifierCaseSensitive: row.caseSensitive,
    });
    const input = { column_flow: [{ out_col: 'Value', upstream_columns: [{ node: row.reference, col: 'Value' }] }] };
    const normalized = normalizeModelInput(schema, input);
    const wire = new Ajv({ strict: false }).compile(toModelJsonSchema(schema));
    expect(validateToolCandidate(schema, normalized.input).success).toBe(row.accepted);
    expect(wire(normalized.input)).toBe(row.accepted);
    if (!row.accepted) expect(normalized).toEqual({ input, fixes: [] });
  });
  it.each(['bb', 'view', 'procedure', 'scalar', 'held'] as const)(
    'keeps normalized metadata identities coherent with the served %s schema', kind => {
      const source = '[dbo].[Source]', caller = '[dbo].[Caller]';
      const mode = kind === 'bb' ? 'bb' : 'ct';
      const held = kind === 'held';
      const schema = submitFindingsSchemaForMode(mode, 'technical', !held, {
        outCols: ['Value'], writesTo: kind === 'procedure', columnSourceNodeIds: [source],
        ...(kind === 'scalar' ? { returnTargets: [{ node: caller, col: 'Value' }] } : {}),
        neighbors: [{ id: source, can_question: true, can_prune: true }],
      }, held);
      const input = { ...(!held ? { summary: 'Recorded findings.', sections: { technical: 'Authored findings.' } } : {}),
        ...(kind === 'bb' || held ? { questions: [{ nodeId: 'dbo.source', question: 'Establish Value.' }] }
          : { column_flow: [{ out_col: 'Value', upstream_columns: [{ node: 'dbo.source', col: 'Value' }],
            ...(kind === 'procedure' ? { writes_to: null } : {}),
            ...(kind === 'scalar' ? { returns_to: { node: 'dbo.caller', col: 'Value' } } : {}),
          }] }),
      };
      const before = structuredClone(input);
      const normalized = normalizeModelInput(schema, input);
      const wire = new Ajv({ strict: false }).compile(toModelJsonSchema(schema));
      expect(normalized.fixes.map(fix => [fix.before, fix.after])).toEqual(kind === 'scalar'
        ? [['dbo.caller', caller], ['dbo.source', source]] : [['dbo.source', source]]);
      expect(validateToolCandidate(schema, normalized.input).success).toBe(true);
      expect(wire(normalized.input)).toBe(true);
      for (const fault of schemaFaults(toModelJsonSchema(schema), normalized.input)) {
        const invalid = withSchemaFaults(normalized.input, [fault]);
        expect(validateToolCandidate(schema, invalid).success, JSON.stringify(fault)).toBe(false);
        expect(wire(invalid), JSON.stringify(fault)).toBe(false);
      }
      expect(input).toEqual(before);
    },
  );
  it('describes held sections as omittable in the actual provider schema', () => {
    const fresh = toModelJsonSchema(submitFindingsSchemaForMode('ct', 'business', true)) as any;
    expect(fresh.properties.sections.description).toMatch(/^Required\./);
    for (const classification of ['business', undefined] as const) {
      const held = toModelJsonSchema(submitFindingsSchemaForMode('ct', classification, false, undefined, true)) as any;
      expect(held.properties.sections.description).not.toMatch(/^Required\./);
      expect(held.properties.sections.description).toContain('held');
    }
  });

  it.each([
    { field: 'prune_neighbors', idKey: 'id', textKey: 'reason' },
    { field: 'questions', idKey: 'nodeId', textKey: 'question' },
  ] as const)('projects readable $field references without admitting invalid actions', ({ field, idKey, textKey }) => {
    const schema = submitFindingsSchemaForMode('ct', undefined, false, {
      outCols: ['Value'], writesTo: false, neighbors: [{ id: 'source', can_question: true, can_prune: true }],
    });
    const raw = { [field]: [{ [idKey]: 'source', [textKey]: 'Explain its role.', surplus: '' }] };
    const before = structuredClone(raw);
    const safe = findingFields(raw, schema);
    expect([...safe.identities.values()]).toEqual(['source']);
    expect(safe.unavailable().has(field)).toBe(true);
    expect(safe.fields).not.toHaveProperty(field);
    expect(raw).toEqual(before);
    // Base-schema references are diagnostic only: the engine must still resolve unknown ids.
    const unknown = findingFields({ [field]: [{ [idKey]: 'unknown', [textKey]: 'Explain its role.' }] }, schema);
    expect([...unknown.identities.values()]).toEqual(['unknown']);
    expect(unknown.unavailable().has(field)).toBe(true);
    expect(unknown.fields).not.toHaveProperty(field);
    expect(findingFields({ [field]: 'source' }, schema).identities.size).toBe(0);
    expect(findingFields({ [field]: [{ [idKey]: 42, [textKey]: 'Explain its role.' }] }, schema).identities.size).toBe(0);
  });

  it.each(['outside', 'OUTSIDE', 'unknown'])('keeps rejected supplier identity %s readable for engine diagnostics without admitting the field', node => {
    const schema = submitFindingsSchemaForMode('ct', 'technical', false, {
      outCols: ['Amount'], writesTo: false, columnSourceNodeIds: ['stored'],
    });
    const input = { column_flow: [{ out_col: 'Amount', upstream_columns: [{ node, col: 'Amount' }] }] };
    const before = structuredClone(input);
    const safe = findingFields(input, schema);
    expect(validateToolCandidate(schema, input).success).toBe(false);
    expect(safe.unavailable().has('column_flow')).toBe(true);
    expect(safe.fields).not.toHaveProperty('column_flow');
    expect([...safe.references]).toEqual([['/column_flow/0/upstream_columns/0/node', node]]);
    expect([...safe.columns]).toEqual([['/column_flow/0/upstream_columns/0/col', 'Amount']]);
    expect(input).toEqual(before);
  });

  it('accepts a valid full resend without decoding malformed sections', () => {
    const schema = submitFindingsSchemaForMode('ct', 'business', false, {
      outCols: ['Value'], writesTo: false,
    });
    const wire = new Ajv({ strict: false }).compile(toModelJsonSchema(schema));
    const full = { focus_node_id: 'focus', column_flow: [], summary: 'Amended summary.', sections: { business: 'Valid decoded prose.' } };
    for (const [input, accepted] of [[full, true], [{ ...full, sections: JSON.stringify(full.sections) }, false],
      [{ ...full, guessed: true }, false]] as const) {
      expect(validateToolCandidate(schema, input).success).toBe(accepted);
      expect(wire(input)).toBe(accepted);
    }
  });
  it('requires a nullable procedure destination at both submission boundaries', () => {
    const schema = submitFindingsSchemaForMode('ct', 'technical', true, {
      outCols: ['Value'], writesTo: true, columnSourceNodeIds: ['input'],
    });
    const wire = new Ajv({ strict: false }).compile(toModelJsonSchema(schema));
    const projected = JSON.stringify(toModelJsonSchema(schema));
    expect(projected).toContain('"required":["out_col","upstream_columns","writes_to"]');
    for (const destination of [{}, { writes_to: null }, { writes_to: { node: 'stored', col: 'Value' } }]) {
      const omitted = !('writes_to' in destination);
      const input = { focus_node_id: 'procedure', summary: 'SQL produces Value.',
        sections: { technical: 'Recorded SQL findings; destination relationships are retained separately.' },
        column_flow: [{ out_col: 'Value', upstream_columns: [{ node: 'input', col: 'Value' }], ...destination }] };
      const parsed = validateToolCandidate(schema, input);
      expect(parsed.success, JSON.stringify(destination)).toBe(!omitted);
      if (parsed.success) expect(parsed.data).toEqual(input);
      expect(wire(input), JSON.stringify(destination)).toBe(!omitted);
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
      columnSourceNodeIds: [canonical],
    };
    for (const part of [
      { questions: [{ nodeId: raw, question: 'Establish Value.' }] },
      { prune_neighbors: [{ id: raw, reason: 'Not needed.' }] },
      { column_flow: [{ out_col: 'Value', upstream_columns: [{ node: raw, col: 'Value' }] }] },
    ]) {
      const input = { focus_node_id: 'focus', column_flow: [], ...part };
      const parsed = validateToolCandidate(submitFindingsSchemaForMode('ct', undefined, false, hop), input);
      expect(parsed.success).toBe(accepted);
      if (parsed.success) expect(parsed.data).toEqual(input);
    }
    const input = { focus_node_id: 'focus', column_flow: [{ out_col: 'Value', upstream_columns: [], returns_to: { node: raw, col: 'Value' } }] };
    const scalar = validateToolCandidate(submitFindingsSchemaForMode('ct', undefined, false, { ...hop, returnTargets: [{ node: canonical, col: 'Value' }] }), input);
    expect(scalar.success).toBe(accepted);
    if (scalar.success) expect(scalar.data).toEqual(input);
  });

  it.each(['bb', 'ct'] as const)('serves an empty neighbor choice set safely in %s', mode => {
    const schema = submitFindingsSchemaForMode(mode, undefined, false, { outCols: null, writesTo: false, neighbors: [] });
    const wire = new Ajv({ strict: false }).compile(toModelJsonSchema(schema));
    const input = { focus_node_id: 'focus', ...(mode === 'ct' ? { column_flow: [] } : {}), questions: [], prune_neighbors: [] };
    expect(validateToolCandidate(schema, input).success).toBe(true);
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
        expect(validateToolCandidate(schema, input).success, `${id} prune=${prune}`).toBe(accepted);
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
        ...(scalar ? { returnTargets: [{ node: 'caller', col: 'Value' }] } : {}),
      });
      const input = { focus_node_id: 'focus', column_flow: [{ out_col: name, upstream_columns: [],
        ...(scalar ? { returns_to: { node: 'caller', col: name } } : {}) }] };
      const before = structuredClone(input);
      const parsed = validateToolCandidate(schema, input);
      expect(parsed.success).toBe(accepted);
      if (parsed.success) expect(parsed.data).toEqual(before);
      expect(input).toEqual(before);
    }
  });

  it.each(['bb', 'ct'] as const)('rejects missing fresh kept fields at both boundaries in %s', mode => {
    const schema = submitFindingsSchemaForMode(mode, 'technical', true);
    const wire = new Ajv({ strict: false }).compile(toModelJsonSchema(schema));
    const accepted = { summary: 'Supplies the amount.',
      sections: { technical: 'Amount is supplied unchanged.' }, ...(mode === 'ct' ? { column_flow: [] } : {}) };
    expect(validateToolCandidate(schema, accepted).success).toBe(true);
    expect(wire(accepted)).toBe(true);
    for (const missing of ['summary', 'sections', ...(mode === 'ct' ? ['column_flow'] : [])]) {
      const invalid: Record<string, unknown> = { ...accepted };
      delete invalid[missing];
      expect(validateToolCandidate(schema, invalid).success).toBe(false);
      expect(wire(invalid), `${missing} must be advertised as required for a fresh finding`).toBe(false);
    }
    const missingAngle = { ...accepted, sections: {} };
    expect(validateToolCandidate(schema, missingAngle).success).toBe(false);
    expect(wire(missingAngle)).toBe(false);
  });

  it('requires an authored angle without a classification lock and preserves input identity', () => {
    const schema = SubmitFindingsCtInputSchema;
    const projected = toModelJsonSchema(schema);
    const wire = new Ajv({ strict: false }).compile(projected);
    for (const sections of [{}, { business: 'Business rule.' }, { technical: 'Execution rule.' }]) {
      const input = { focus_node_id: 'source', summary: 'Supplies the amount.', column_flow: [], sections };
      const before = structuredClone(input);
      expect(wire(input)).toBe(Object.keys(sections).length > 0);
      expect(validateToolCandidate(schema, input).success).toBe(Object.keys(sections).length > 0);
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
    expect(validateToolCandidate(schema, deadEnd).success).toBe(true);
    expect(wire(deadEnd)).toBe(true);
    for (const obsolete of [{ verdict: 'analyze' }, { verdict: 'passthrough' }, { verdict: 'end_branch' }, { reason: 'Unused legacy field.' }]) {
      expect(validateToolCandidate(schema, { ...deadEnd, ...obsolete }).success).toBe(false);
      expect(wire({ ...deadEnd, ...obsolete })).toBe(false);
    }
  });

  it.each(['', '   '])('rejects an explicitly blank repair summary %j instead of retaining an older summary silently', summary => {
    const schema = submitFindingsSchemaForMode('ct', 'technical', false);
    expect(validateToolCandidate(schema, { focus_node_id: 'source', summary, column_flow: [] }).success).toBe(false);
    expect(validateToolCandidate(schema, { focus_node_id: 'source', column_flow: [] }).success).toBe(true);
  });

  it('accepts held patches without resending held content', () => {
    const schema = submitFindingsSchemaForMode('ct', 'both', false);
    const wire = new Ajv({ strict: false }).compile(toModelJsonSchema(schema));
    const patch = { focus_node_id: 'source', column_flow: [] };
    expect(validateToolCandidate(schema, patch).success).toBe(true);
    expect(wire(patch)).toBe(true);
    const oneAngle = { ...patch, sections: { technical: 'Corrected mechanics.' } };
    expect(validateToolCandidate(schema, oneAngle).success).toBe(true);
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
    ];
    for (const correction of corrections) {
      const patch = { ...envelope, ...correction };
      expect(validateToolCandidate(held, patch).success).toBe(true);
      expect(wire(patch)).toBe(true);
      expect(validateToolCandidate(unheld, patch).success).toBe(false);
      expect(unheldWire(patch)).toBe(false);
    }
    for (const patch of [{ ...envelope, column_flow: [] }]) {
      expect(validateToolCandidate(held, patch).success).toBe(true);
      expect(wire(patch)).toBe(true);
    }
    for (const patch of [{ ...envelope, extra: true }, { ...envelope, questions: [{ nodeId: 'neighbor' }] }]) {
      expect(validateToolCandidate(held, patch).success).toBe(false);
      expect(wire(patch)).toBe(false);
    }
  });

  it.each(['bb', 'ct'] as const)('requires both fresh locked angles without changing input or contaminating a held schema in %s', mode => {
    const held = submitFindingsSchemaForMode(mode, 'both', false);
    const fresh = submitFindingsSchemaForMode(mode, 'both', true);
    const wire = new Ajv({ strict: false }).compile(toModelJsonSchema(fresh));
    for (const sections of [{ business: 'Business rule.' }, { technical: 'Execution rule.' }]) {
      const partial = { focus_node_id: 'source', summary: 'Supplies the amount.', ...(mode === 'ct' ? { column_flow: [] } : {}), sections };
      const before = structuredClone(partial);
      expect(validateToolCandidate(fresh, partial).success).toBe(false);
      expect(wire(partial)).toBe(false);
      expect(validateToolCandidate(held, partial).success).toBe(true);
      expect(new Ajv({ strict: false }).compile(toModelJsonSchema(held))(partial)).toBe(true);
      expect(partial).toEqual(before);
    }
    const complete = { focus_node_id: 'source', summary: 'Supplies the amount.',
      ...(mode === 'ct' ? { column_flow: [] } : {}), sections: { business: 'Business rule.', technical: 'Execution rule.' } };
    expect(validateToolCandidate(fresh, complete).success).toBe(true);
    expect(wire(complete)).toBe(true);
  });

  it.each(['bb', 'ct'] as const)('honours a held submission without a classification in %s', mode => {
    const held = submitFindingsSchemaForMode(mode, undefined, false);
    const fresh = submitFindingsSchemaForMode(mode, undefined, true);
    const patch = { focus_node_id: 'source', ...(mode === 'ct' ? { column_flow: [] } : {}) };
    expect(validateToolCandidate(held, patch).success).toBe(true);
    expect(new Ajv({ strict: false }).compile(toModelJsonSchema(held))(patch)).toBe(true);
    expect(validateToolCandidate(fresh, patch).success).toBe(false);
    expect(new Ajv({ strict: false }).compile(toModelJsonSchema(fresh))(patch)).toBe(false);
  });

  it('normalizes an equivalent caller_context spelling to the focus id at the boundary without changing the served schema', () => {
    const hop = { focusNodeId: '[dbo].[Caller]', outCols: ['Value'], writesTo: false, callerContextNodeIds: ['[dbo].[Fn]'],
      neighbors: [{ id: '[dbo].[Fn]', can_question: true, can_prune: true }] };
    const schema = submitFindingsSchemaForMode('ct', undefined, false, hop);
    const question = { nodeId: '[dbo].[Fn]', question: 'Establish Value from the caller argument.' };
    const input = { column_flow: [], questions: [{ ...question, caller_context: { node: 'dbo.Caller', col: 'Value' } }] };
    const normalized = normalizeModelInput(schema, input);
    expect(normalized.input).toEqual({ column_flow: [], questions: [{ ...question, caller_context: { node: '[dbo].[Caller]', col: 'Value' } }] });
    expect(normalized.fixes).toEqual([{ path: 'questions.0.caller_context.node', before: 'dbo.Caller', after: '[dbo].[Caller]' }]);
    for (const node of ['dbo.Other', '[dbo].[Fn]']) {
      const other = { column_flow: [], questions: [{ ...question, caller_context: { node, col: 'Value' } }] };
      expect(normalizeModelInput(schema, other)).toEqual({ input: other, fixes: [] });
    }
    expect(JSON.stringify(toModelJsonSchema(schema))).not.toContain('[dbo].[Caller]');
  });
});


it.each(['view', 'procedure', 'caller'] as const)('keeps a served %s flow example coherent with its owning schema', kind => {
  const source = '[dbo].[Orders]', target = '[dbo].[Target]', caller = '[dbo].[Caller]';
  const schema = submitFindingsSchemaForMode('ct', 'technical', false, {
    outCols: ['Total'], writesTo: kind === 'procedure', columnSourceNodeIds: [source],
    ...(kind === 'procedure' ? { writeTargetNodeIds: [target] } : {}),
    ...(kind === 'caller' ? { returnTargets: [{ node: caller, col: 'Total' }] } : {}),
  });
  const wire = toModelJsonSchema(schema) as any;
  const description = wire.properties.column_flow.description as string;
  for (const match of description.matchAll(/Example:\s*(\[[\s\S]*?\])\.\s+Reference /g)) {
    const shown = { column_flow: JSON.parse(match[1]!) };
    const parsed = validateToolCandidate(schema, shown);
    expect(parsed.success, JSON.stringify(parsed.success ? [] : parsed.rejection.errors)).toBe(true);
    expect(new Ajv({ strict: false }).compile(wire)(shown)).toBe(true);
  }
});

it.each((['bb', 'ct'] as const).flatMap(mode => (['business', 'technical', 'both'] as const)
  .map(classification => ({ mode, classification }))))('preserves declared summary guidance on the $mode/$classification repair schema', ({ mode, classification }) => {
  const fresh = toModelJsonSchema(submitFindingsSchemaForMode(mode, classification, true)) as any;
  const repair = toModelJsonSchema(submitFindingsSchemaForMode(mode, classification, false)) as any;
  expect(repair.properties.summary.description).toBe(fresh.properties.summary.description);
  expect(repair.properties.summary.pattern).toBe('\\S');
  expect(repair.required ?? []).not.toContain('summary');
});

// Resource bound (no spec clause owns it): distinct hops arrive for the life of the extension host, so neither Ajv nor the
// per-hop schema memo may keep every schema ever built. The compiled validator must stay usable without its Ajv cache entry.
it('retains no Ajv cache entry per hop and bounds the per-hop findings schemas', () => {
  const hop = (i: number) => ({ focusNodeId: `[dbo].[Focus${i}]`, outCols: ['Value'], writesTo: false, columnSourceNodeIds: [`[dbo].[Src${i}]`] });
  const build = (i: number) => submitFindingsSchemaForMode('ct', 'technical', false, hop(i));
  const flow = (i: number) => ({ column_flow: [{ out_col: 'Value', upstream_columns: [{ node: `[dbo].[Src${i}]`, col: 'Value' }] }] });
  const compile = vi.spyOn(Ajv.prototype, 'compile');
  try {
    const first = build(0);
    expect(validateToolCandidate(first, flow(0)).success).toBe(true);
    const cache = (compile.mock.contexts[0] as unknown as { _cache: Map<unknown, unknown> })._cache, baseline = cache.size;
    for (let i = 1; i < 40; i++) {
      const schema = build(i);
      expect(validateToolCandidate(schema, flow(i)).success).toBe(true);
      expect(validateToolCandidate(schema, { column_flow: 42 }).success).toBe(false);
    }
    expect(compile).toHaveBeenCalledTimes(40);
    expect(cache.size, 'compiled schemas do not accumulate in the Ajv cache').toBe(baseline);
    expect(validateToolCandidate(first, flow(0)).success, 'a compiled validator outlives its cache entry').toBe(true);
    expect(build(0), 'schemas of earlier hops are not kept forever').not.toBe(first);
  } finally { compile.mockRestore(); }
});
