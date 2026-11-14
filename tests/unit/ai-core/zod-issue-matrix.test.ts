// Owner: src/ai/support/toolErrorEnvelope.ts with real tools/toolSchemas.ts; rejection diagnostic
// contracts.
/**
 * Real canonical tool schemas preserve each fault path, issue code and metadata values. Messages
 * belong to the issue-code table.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { validateToolCandidate } from '../../../src/ai/support/toolValidation';
import {
  GetScopeBundleModelSchema,
  PresentResultModelSchema,
  presentResultSchemaForPhase,
  startExplorationSchemaForState,
} from '../../../src/ai/tools/toolSchemas';

const reject = (schema: z.ZodType, input: unknown) => {
  const parsed = validateToolCandidate(schema, input);
  expect(parsed.success).toBe(false);
  if (parsed.success) throw new Error('Expected canonical admission faults');
  return parsed.rejection;
};

const render = {
  name: 'Orders lineage',
  summary: 'How Orders is produced.',
  highlight_groups: [
    { label: 'Sources', color: 'source', node_ids: ['dbo.a'] },
  ],
  sections: [{ label: 'Sources', node_ids: ['dbo.a'], text: 'Reads dbo.a.' }],
};

type Fault = { path: string; code: string; values?: unknown };

describe('Canonical tool issue matrix', () => {
  it.each<{
    name: string;
    schema: z.ZodType;
    input: unknown;
    faults: Fault[];
    values?: string[];
  }>([
    {
      // A scope needs a depth on each side; only upstream is given.
      name: 'asymmetric scope: missing downstream_depth',
      schema: GetScopeBundleModelSchema,
      input: { origin: 'dbo.a', upstream_depth: 2 },
      faults: [{ path: 'downstream_depth', code: 'missing' }],
    },
    // A string where the schema requires a list or an object is the validator's `type` fault,
    // whatever the string holds ('several faults in one call').
    {
      name: 'valid JSON encoded as a string',
      schema: PresentResultModelSchema,
      input: { ...render, sections: JSON.stringify(render.sections) },
      faults: [{ path: 'sections', code: 'type' }],
    },
    {
      name: 'text that is not valid JSON',
      schema: PresentResultModelSchema,
      input: { ...render, sections: '[{"label":"Sources","node_ids":["dbo.a"' },
      faults: [{ path: 'sections', code: 'type' }],
    },
    {
      name: 'the same defect across list entries: one fault per entry',
      schema: PresentResultModelSchema,
      input: {
        ...render,
        sections: ['A', 'B', 'C'].map((label) => ({
          label,
          node_ids: [],
          text: '',
        })),
      },
      faults: [0, 1, 2].map((index) => ({
        path: `sections.${index}.text`,
        code: 'size',
      })),
    },
    {
      name: 'several faults in one call',
      schema: PresentResultModelSchema,
      input: {
        name: 7,
        summary: 's',
        title: 8,
        highlight_groups: [{ label: '', color: 'blue', node_ids: 'dbo.a' }],
        sections: 'Sources: reads dbo.a',
        notes: [{ node_id: 'dbo.a' }],
        layout: 'LR',
      },
      faults: [
        { path: 'layout', code: 'unknown_key' },
        { path: 'name', code: 'type' },
        { path: 'title', code: 'type' },
        { path: 'sections', code: 'type' },
        { path: 'highlight_groups.0.label', code: 'size' },
        { path: 'highlight_groups.0.color', code: 'enum' },
        { path: 'highlight_groups.0.node_ids', code: 'type' },
        { path: 'notes.0.caption', code: 'missing' },
      ],
      values: ['blue', 'LR'],
    },
    {
      name: 'a null section entry beside a duplicate valid label',
      schema: presentResultSchemaForPhase('synthesis'),
      input: {
        ...render,
        sections: [
          null,
          { label: 'Origin', node_ids: ['dbo.a'], text: 'Reads dbo.a.' },
          { label: ' origin ', node_ids: ['dbo.a'], text: 'Reads dbo.a.' },
        ],
      },
      faults: [
        { path: 'sections.0', code: 'type' },
        { path: 'sections.2.label', code: 'duplicate' },
      ],
    },
    {
      name: 'every mistyped start_exploration field',
      schema: startExplorationSchemaForState(false),
      input: {
        origin: 8,
        classification: 9,
        analysisMode: 10,
        question: 11,
        excludeSchemas: 12,
      },
      faults: [
        { path: 'depth', code: 'missing' },
        { path: 'origin', code: 'type' },
        { path: 'analysisMode', code: 'enum', values: ['bb', 'ct'] },
        { path: 'excludeSchemas', code: 'type' },
        { path: 'question', code: 'type' },
        {
          path: 'classification',
          code: 'enum',
          values: ['business', 'technical', 'both'],
        },
      ],
    },
  ])(
    '$name: every fault by path and issue code, values only from metadata',
    ({ schema, input, faults, values = [] }) => {
      const r = reject(schema, input);
      expect(r.code).toBe('invalid_input');
      for (const fault of faults)
        expect(r.errors).toContainEqual(expect.objectContaining(fault));
      expect(r.issuePaths).toEqual(
        expect.arrayContaining(faults.map((fault) => fault.path)),
      );
      expect(r.resend ?? []).toEqual([]);
      // A submitted value is never carried as a value.
      for (const value of values)
        expect(JSON.stringify(r.errors)).not.toContain(value);
    },
  );
});
