// Owner: src/ai/support/toolErrorEnvelope.ts with real tools/toolSchemas.ts; rejection diagnostic contracts.
/** Real canonical tool schemas preserve each fault path, issue code and metadata values (D-103). Messages belong to the issue-code table. */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { validateToolCandidate } from '../../../src/ai/support/toolValidation';
import {
  GetObjectDetailInputSchema,
  GetScopeBundleInputSchema,
  GetScreenStateInputSchema,
  PresentResultModelSchema,
  SearchObjectsInputSchema,
  StartExplorationProviderInputSchema,
  SubmitFindingsBbInputSchema,
  submitFindingsSchemaForMode,
} from '../../../src/ai/tools/toolSchemas';

const reject = (schema: z.ZodType, input: unknown) => {
  const parsed = validateToolCandidate(schema, input);
  expect(parsed.success).toBe(false);
  if (parsed.success) throw new Error('Expected canonical admission faults');
  return parsed.rejection;
};

const render = {
  name: 'Orders lineage', summary: 'How Orders is produced.',
  highlight_groups: [{ label: 'Sources', color: 'source', node_ids: ['dbo.a'] }],
  sections: [{ label: 'Sources', node_ids: ['dbo.a'], text: 'Reads dbo.a.' }],
};

const closedNeighbor = (field: 'prune_neighbors' | 'questions') => ({
  schema: submitFindingsSchemaForMode('bb', 'technical', true, { outCols: null, outNode: false,
    neighbors: [{ id: '[demo].[closed]', can_prune: false, can_question: false }] }),
  input: { focus_node_id: '[demo].[focus]', summary: 'A supported finding.', sections: { technical: 'The supplied SQL establishes this finding.' },
    [field]: [field === 'prune_neighbors' ? { id: '[demo].[closed]', reason: 'Not needed.' } : { nodeId: '[demo].[closed]', question: 'What supplies the value?' }] },
});

type Fault = { path: string; code: string; values?: unknown };

describe('Canonical tool issue matrix', () => {
  it.each<{ name: string; schema: z.ZodType; input: unknown; faults: Fault[]; values?: string[] }>([
    ...(['upstream_depth', 'downstream_depth'] as const).map(missing => ({
      name: `Approved08 asymmetric scope: missing ${missing}`, schema: GetScopeBundleInputSchema,
      input: { origin: 'dbo.a', direction: 'bidirectional', [missing === 'upstream_depth' ? 'downstream_depth' : 'upstream_depth']: 2 },
      faults: [{ path: missing, code: 'missing' }],
    })),
    { name: 'invalid_type, absent', schema: SearchObjectsInputSchema, input: {}, faults: [{ path: 'query', code: 'missing' }] },
    { name: 'empty arguments', schema: GetObjectDetailInputSchema, input: {}, faults: [{ path: 'id', code: 'missing' }] },
    { name: 'invalid_type, present with the wrong type', schema: PresentResultModelSchema, input: { ...render, highlight_groups: 'Sources' },
      faults: [{ path: 'highlight_groups', code: 'type' }] },
    { name: 'valid JSON encoded as a string', schema: PresentResultModelSchema, input: { ...render, sections: JSON.stringify(render.sections) },
      faults: [{ path: 'sections', code: 'json_text' }] },
    { name: 'text that is not valid JSON', schema: PresentResultModelSchema, input: { ...render, sections: '[{"label":"Sources","node_ids":["dbo.a"' },
      faults: [{ path: 'sections', code: 'json_text' }] },
    { name: 'a prune_neighbors entry with no eligible IDs', ...closedNeighbor('prune_neighbors'), faults: [{ path: 'prune_neighbors.0.id', code: 'never' }] },
    { name: 'a questions entry with no eligible IDs', ...closedNeighbor('questions'), faults: [{ path: 'questions.0.nodeId', code: 'never' }] },
    { name: 'unrecognized_keys at the root', schema: GetObjectDetailInputSchema, input: { id: 'dbo.a', depth: 2 },
      faults: [{ path: 'depth', code: 'unknown_key', values: ['id', 'cursor'] }] },
    { name: 'unrecognized_keys at the root and inside a list entry', schema: PresentResultModelSchema,
      input: { ...render, caption: 'x', sections: [{ label: 'S', node_ids: [], text: 't', caption: 'c' }] },
      faults: [{ path: 'caption', code: 'unknown_key', values: expect.arrayContaining(['sections', 'notes']) },
        { path: 'sections.0.caption', code: 'unknown_key', values: expect.arrayContaining(['label', 'text']) }] },
    { name: 'invalid_value', schema: PresentResultModelSchema, input: { ...render, highlight_groups: [{ label: 'S', color: 'blue', node_ids: ['dbo.a'] }] },
      faults: [{ path: 'highlight_groups.0.color', code: 'enum', values: expect.arrayContaining(['source']) }], values: ['blue'] },
    { name: 'too_small on an array', schema: PresentResultModelSchema, input: { ...render, highlight_groups: [] },
      faults: [{ path: 'highlight_groups', code: 'size' }] },
    { name: 'too_big on a string', schema: SubmitFindingsBbInputSchema,
      input: { focus_node_id: 'dbo.a', summary: 'Source detail.', sections: { technical: 'Source detail.' }, badge_label: 'x'.repeat(200) },
      faults: [{ path: 'badge_label', code: 'size' }], values: ['x'.repeat(200)] },
    { name: 'too_small on a string', schema: PresentResultModelSchema, input: { ...render, highlight_groups: [{ label: 'S', color: 'source', node_ids: [''] }] },
      faults: [{ path: 'highlight_groups.0.node_ids.0', code: 'size' }] },
    { name: 'invalid_format', schema: GetObjectDetailInputSchema, input: { id: 'dbo.a', cursor: 'next' }, faults: [{ path: 'cursor', code: 'invalid' }] },
    { name: 'custom refinement of an absent field', schema: SubmitFindingsBbInputSchema, input: { focus_node_id: 'dbo.a', summary: 'S.' },
      faults: [{ path: 'sections', code: 'missing' }] },
    { name: 'invalid_union: the faults of every variant', schema: StartExplorationProviderInputSchema, input: { analysisMode: 'bb', depth: 'deep' },
      faults: [{ path: 'origin', code: 'missing' }, { path: 'depth', code: 'type' }] },
    { name: 'the same defect across list entries: one fault per entry', schema: PresentResultModelSchema,
      input: { ...render, sections: ['A', 'B', 'C'].map(label => ({ label, node_ids: [], text: '' })) },
      faults: [0, 1, 2].map(index => ({ path: `sections.${index}.text`, code: 'size' })) },
    { name: 'several faults in one call', schema: PresentResultModelSchema,
      input: { name: 7, summary: 's', title: 8, highlight_groups: [{ label: '', color: 'blue', node_ids: 'dbo.a' }],
        sections: 'Sources: reads dbo.a', notes: [{ node_id: 'dbo.a' }], layout: 'LR' },
      faults: [{ path: 'layout', code: 'unknown_key' }, { path: 'name', code: 'type' }, { path: 'title', code: 'type' }, { path: 'sections', code: 'type' },
        { path: 'highlight_groups.0.label', code: 'size' }, { path: 'highlight_groups.0.color', code: 'enum' },
        { path: 'highlight_groups.0.node_ids', code: 'type' }, { path: 'notes.0.caption', code: 'missing' }], values: ['blue', 'LR'] },
  ])('$name: every fault by path and issue code, values only from metadata', ({ schema, input, faults, values = [] }) => {
    const r = reject(schema, input);
    for (const fault of faults) expect(r.errors).toContainEqual(expect.objectContaining(fault));
    expect(r.issuePaths).toEqual(expect.arrayContaining(faults.map(fault => fault.path)));
    expect(r.resend ?? []).toEqual([]);
    // D-102: a submitted value is never carried as a value.
    for (const value of values) expect(JSON.stringify(r.errors)).not.toContain(value);
  });

  it('a structured field sent as text is told apart from a plain wrong type', () => {
    const code = (input: unknown) => reject(PresentResultModelSchema, input).errors.find(error => error.path === 'sections')!.code;
    expect([JSON.stringify(render.sections), '[{"label":"Sources"', 7].map(sections => code({ ...render, sections }))).toEqual(['json_text', 'json_text', 'type']);
  });

  it('an entry with no eligible ids can be withdrawn by the served schema', () => {
    for (const field of ['prune_neighbors', 'questions'] as const) {
      const { schema, input } = closedNeighbor(field);
      expect(schema.safeParse({ ...input, [field]: [] }).success).toBe(true);
    }
  });

  it('a custom refinement without allowed values carries the issue code it names', () => {
    const r = reject(GetScreenStateInputSchema, { ids: ['dbo.a'], filter: 'pruned' });
    expect(r.errors).toEqual([{ path: 'filter', code: 'never' }]);
  });
});
