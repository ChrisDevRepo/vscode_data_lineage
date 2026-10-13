/**
 * One case per Zod issue kind the model-facing tool schemas can emit, against the real schemas,
 * asserting the reason line and the repair hint the model reads
 * (tool-input rejection text). A Zod upgrade that renames an
 * issue code or rewords a message fails here first.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { rejectionFromZodError, INVALID_TOOL_INPUT_REPAIR_HINT } from '../../../src/ai/support/toolErrorEnvelope';
import {
  GetObjectDetailInputSchema,
  GetScreenStateInputSchema,
  PresentResultModelSchema,
  SearchObjectsInputSchema,
  StartExplorationProviderInputSchema,
  SubmitFindingsBbInputSchema,
} from '../../../src/ai/tools/toolSchemas';

const reject = (schema: z.ZodType, input: unknown) => {
  const parsed = schema.safeParse(input);
  expect(parsed.success).toBe(false);
  return rejectionFromZodError(parsed.error!, { code: 'invalid_input', input, schema });
};

const render = {
  name: 'Orders lineage', summary: 'How Orders is produced.',
  highlight_groups: [{ label: 'Sources', color: 'source', node_ids: ['dbo.a'] }],
  sections: [{ label: 'Sources', node_ids: ['dbo.a'], text: 'Reads dbo.a.' }],
};

describe('Zod issue matrix', () => {
  it('invalid_type, absent: names the field as missing and directs addition', () => {
    const r = reject(SearchObjectsInputSchema, {});
    expect(r.reason).toContain('expected string, received undefined');
    expect(r.hint).toContain('"query" is missing entirely from this call');
    expect(r.issuePaths).toEqual(['query']);
  });

  it('invalid_type, present with the wrong type: states the expected type and shape', () => {
    const r = reject(PresentResultModelSchema, { ...render, highlight_groups: 'Sources' });
    expect(r.reason).toContain('expected array, received string');
    expect(r.hint).toContain('Send "highlight_groups" as an array.');
  });

  it('invalid_type on text that is not valid JSON: never completed, named as cut-off text', () => {
    const r = reject(PresentResultModelSchema, { ...render, sections: '[{"label":"Sources","node_ids":["dbo.a"' });
    expect(r.reason).toMatch(/received \d+ characters of text that is not valid JSON/);
    expect(r.reason).toContain('Send it again as one complete JSON array');
  });

  it('empty arguments: diagnosed as a lost call ahead of the field list', () => {
    const r = reject(SubmitFindingsBbInputSchema, {});
    expect(r.hint!.startsWith('The call arrived with no arguments at all')).toBe(true);
    expect(r.hint).toContain('"focus_node_id"');
  });

  it('unrecognized_keys at the root: names the key and the fields of the call', () => {
    const r = reject(GetObjectDetailInputSchema, { id: 'dbo.a', depth: 2 });
    expect(r.reason).toContain('Unrecognized key: "depth"');
    expect(r.hint).toContain('"depth" is not a field of the call; its fields are id, cursor');
    expect(r.issuePaths).toEqual(['depth']);
  });

  it('unrecognized_keys inside a list entry: names the entry fields and the list a flattened key belongs to', () => {
    const r = reject(PresentResultModelSchema, { ...render, caption: 'x', sections: [{ label: 'S', node_ids: [], text: 't', caption: 'c' }] });
    expect(r.hint).toContain('"caption" is not a field of the call');
    expect(r.hint).toContain('is a field of a notes[] entry: send it there');
  });

  it('invalid_value: lists the accepted values once, in the hint', () => {
    const r = reject(PresentResultModelSchema, { ...render, highlight_groups: [{ label: 'S', color: 'blue', node_ids: ['dbo.a'] }] });
    expect(r.reason).toContain('Invalid value');
    expect(r.reason).not.toContain('"source"');
    expect(r.hint).toContain('Set "highlight_groups[].color" to one of "source"');
  });

  it('too_small on an array: counts the items and asks for the missing ones', () => {
    const r = reject(PresentResultModelSchema, { ...render, highlight_groups: [] });
    expect(r.reason).toContain('0 items, minimum 1');
    expect(r.hint).toContain('Add the missing items to "highlight_groups"');
  });

  it('too_big on a string: measures the text, states the cap and the shorten action, never a cut', () => {
    const r = reject(PresentResultModelSchema, { ...render, name: 'x'.repeat(200) });
    expect(r.reason).toContain('200 chars, limit 90');
    expect(r.hint).toContain('Shorten "name" to at most 90 characters; the engine never truncates authored text.');
    expect(r.hint).toContain(INVALID_TOOL_INPUT_REPAIR_HINT);
  });

  it('too_small on a string: measures the text and asks for it', () => {
    const r = reject(PresentResultModelSchema, { ...render, highlight_groups: [{ label: 'S', color: 'source', node_ids: [''] }] });
    expect(r.reason).toContain('0 chars, minimum 1');
    expect(r.hint).toContain('Send "highlight_groups.0.node_ids.0" with at least 1 character.');
  });

  it('invalid_format: the schema\'s own rule is the reason', () => {
    const r = reject(GetObjectDetailInputSchema, { id: 'dbo.a', cursor: 'next' });
    expect(r.reason).toContain('cursor must be the next_cursor value of the previous result');
    expect(r.hint).toBe(INVALID_TOOL_INPUT_REPAIR_HINT);
  });

  it('custom with its own hint: the refinement\'s repair leads', () => {
    const r = reject(SubmitFindingsBbInputSchema, { focus_node_id: 'dbo.a', verdict: 'analyze', summary: 'S.' });
    expect(r.reason).toContain('required with verdict analyze');
    expect(r.hint!.startsWith('Send sections: the section body keyed by angle.')).toBe(true);
  });

  it('custom without a hint: the message names the rule', () => {
    const r = reject(GetScreenStateInputSchema, { ids: ['dbo.a'], filter: 'pruned' });
    expect(r.reason).toContain('Send either ids or filter, never both');
  });

  it('invalid_union: every variant is listed with its missing and faulty fields', () => {
    const r = reject(StartExplorationProviderInputSchema, { analysisMode: 'bb', depth: 'deep' });
    expect(r.reason).toContain('input matched no variant; supply all required fields of one variant');
    expect(r.reason).toContain('depth: Invalid input: expected object, received string');
    expect(r.issuePaths).toContain('origin');
  });

  it('several faults in one call: every fault is listed with its field, and every field gets a repair that names it', () => {
    const input = {
      name: 'x'.repeat(200), summary: 's', title: 't'.repeat(300),
      highlight_groups: [{ label: 'y'.repeat(70), color: 'blue', node_ids: 'dbo.a' }],
      sections: 'Sources: reads dbo.a', notes: [{ node_id: 'dbo.a' }], layout: 'LR',
    };
    const r = reject(PresentResultModelSchema, input);
    const faults = ['layout', 'name', 'title', 'sections', 'highlight_groups.0.label', 'highlight_groups.0.color', 'highlight_groups.0.node_ids', 'notes.0.caption'];
    expect(r.issuePaths).toEqual(expect.arrayContaining(faults));
    for (const path of ['name', 'title', 'sections', 'highlight_groups[0].label', 'highlight_groups[0].color', 'highlight_groups[0].node_ids', 'notes[0].caption']) {
      expect(r.reason, `reason names ${path}`).toContain(`→ at ${path}`);
    }
    const hint = r.hint!;
    expect(hint).toContain('"layout" is not a field of the call');
    expect(hint).toContain('Shorten "name" to at most 90 characters');
    expect(hint).toContain('Shorten "title" to at most 120 characters');
    expect(hint).toContain('Shorten "highlight_groups.0.label" to at most 60 characters');
    expect(hint).toMatch(/Send ("sections", "highlight_groups\.0\.node_ids"|"highlight_groups\.0\.node_ids", "sections") as an array\./);
    expect(hint).toContain('Set "highlight_groups[].color" to one of');
    expect(hint).toContain('Field "notes.0.caption" is missing entirely from this call');
    expect(hint.endsWith(INVALID_TOOL_INPUT_REPAIR_HINT)).toBe(true);
  });

  it('two wrong-type faults of different shapes each name their field', () => {
    const r = reject(PresentResultModelSchema, { ...render, name: 7, highlight_groups: 'Sources' });
    expect(r.hint).toContain('Send "name" as a string.');
    expect(r.hint).toContain('Send "highlight_groups" as an array.');
  });

  it('the same defect across list entries is one line naming the other indices', () => {
    const r = reject(PresentResultModelSchema, { ...render, sections: [
      { label: 'A', node_ids: [], text: '' }, { label: 'B', node_ids: [], text: '' }, { label: 'C', node_ids: [], text: '' },
    ] });
    expect(r.reason.match(/0 chars, minimum 1/g)).toHaveLength(1);
    expect(r.reason).toContain('same at sections[1].text, sections[2].text');
    expect(r.hint).toContain('Send "sections.0.text", "sections.1.text", "sections.2.text" with at least 1 character.');
  });
});
