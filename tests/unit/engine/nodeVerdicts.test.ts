/**
 * AI view metadata at the webview boundary: transform classes map to one lineage direction, and the
 * strict write schema rejects malformed column descriptors.
 */
import { describe, it, expect } from 'vitest';
import {
  COLUMN_TRANSFORM_CLASSES,
  COLUMN_TRANSFORM_DIRECTION,
  ExtensionToWebviewMsgSchema,
} from '../../../src/engine/shared/bridgeContract';

/** Field paths a refused parse names; [] when the parse succeeds. */
function rejectedPaths(result: {
  success: boolean;
  error?: { issues: Array<{ path: PropertyKey[] }> };
}): string[] {
  return result.success
    ? []
    : result.error!.issues.map((issue) => issue.path.map(String).join('.'));
}

const baseAiMetadata = {
  createdAt: '2026-01-01T00:00:00.000Z',
  modelName: 'Test Model',
  highlightGroups: [],
  badges: [],
};

describe('AIViewMetadata.columnAspect edge transforms', () => {
  it('maps every declared class to exactly one direction, and the split matches the contract', () => {
    expect(Object.keys(COLUMN_TRANSFORM_DIRECTION).sort()).toEqual(
      [...COLUMN_TRANSFORM_CLASSES].sort(),
    );
    expect(
      COLUMN_TRANSFORM_CLASSES.filter(
        (c) => COLUMN_TRANSFORM_DIRECTION[c] === 'DIRECT',
      ),
    ).toEqual(['pass_through', 'compute', 'aggregate']);
    expect(
      COLUMN_TRANSFORM_CLASSES.filter(
        (c) => COLUMN_TRANSFORM_DIRECTION[c] === 'INDIRECT',
      ),
    ).toEqual(['combine', 'filter']);
  });
});

describe('AIViewMetadata requested columns', () => {
  const requested = { node: '[dbo].[Target]', columns: ['Value', 'Unmapped'] };
  it.each([
    {
      invalid: { node: requested.node, columns: 'Value' },
      path: 'aiMetadata.columnAspect.requested.columns',
    },
    {
      invalid: { node: requested.node, columns: ['Value'], extra: true },
      path: 'aiMetadata.columnAspect.requested',
    },
    {
      invalid: { columns: ['Value'] },
      path: 'aiMetadata.columnAspect.requested.node',
    },
  ])(
    'rejects a malformed descriptor at $path: $invalid',
    ({ invalid, path }) => {
      expect(
        rejectedPaths(
          ExtensionToWebviewMsgSchema.safeParse({
            type: 'ai-view-preview',
            name: 'Trace',
            nodeIds: [requested.node],
            aiMetadata: {
              ...baseAiMetadata,
              columnAspect: { edges: [], requested: invalid },
            },
          }),
        ),
      ).toEqual([path]);
    },
  );
});
