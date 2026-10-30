/** CT-only additive fields on `AIViewMetadata`: per-node `nodeVerdicts` (host-wire package P2) and the per-edge `columnAspect.edges[].transforms` classification. */
import { describe, it, expect } from 'vitest';
import {
  COLUMN_TRANSFORM_CLASSES,
  COLUMN_TRANSFORM_DIRECTION,
  ExtensionToWebviewMsgSchema,
  ProjectReadSchema,
  type FilterProfile,
} from '../../../src/engine/shared/bridgeContract';
import type { DacpacConnection } from '../../../src/engine/projectStore';

const dacpacConn: DacpacConnection = {
  type: 'dacpac',
  path: '/data/AdventureWorks.dacpac',
  displayName: 'AdventureWorks',
  schemas: ['dbo', 'Sales'],
};

const baseAiMetadata = {
  createdAt: '2026-01-01T00:00:00.000Z',
  modelName: 'Test Model',
  highlightGroups: [],
  badges: [],
};

describe('AIViewMetadata.nodeVerdicts', () => {
  it('round-trips through the strict ai-view-preview write schema', () => {
    const msg = {
      type: 'ai-view-preview',
      name: 'Trace',
      nodeIds: ['[dbo].[FactSales]', '[dbo].[DimDate]'],
      aiMetadata: {
        ...baseAiMetadata,
        nodeVerdicts: [
          { nodeId: '[dbo].[FactSales]', verdict: 'analyze' },
          { nodeId: '[dbo].[DimDate]', verdict: 'passthrough' },
        ],
      },
    };
    const parsed = ExtensionToWebviewMsgSchema.safeParse(msg);
    expect(parsed.success).toBe(true);
    expect(
      parsed.success &&
        parsed.data.type === 'ai-view-preview' &&
        parsed.data.aiMetadata.nodeVerdicts,
    ).toEqual(msg.aiMetadata.nodeVerdicts);
  });

  it('rejects an unrecognised verdict value on the strict write schema', () => {
    const msg = {
      type: 'ai-view-preview',
      name: 'Trace',
      nodeIds: ['[dbo].[FactSales]'],
      aiMetadata: {
        ...baseAiMetadata,
        nodeVerdicts: [{ nodeId: '[dbo].[FactSales]', verdict: 'contracted' }],
      },
    };
    expect(ExtensionToWebviewMsgSchema.safeParse(msg).success).toBe(false);
  });

  it('keeps a persisted project whose nodeVerdicts entries carry an unrecognised field', () => {
    const filterProfiles: FilterProfile[] = [
      {
        id: 'view-1',
        name: 'CT View',
        createdAt: '2026-01-01T00:00:00.000Z',
        filter: {
          schemas: [],
          types: [],
          hideIsolated: false,
          focusSchemas: [],
          showExternalRefs: true,
          externalRefTypes: [],
        },
        aiMetadata: {
          ...baseAiMetadata,
          nodeVerdicts: [{ nodeId: '[dbo].[FactSales]', verdict: 'analyze' }],
        },
      },
    ];
    const project = {
      id: 'proj-1',
      name: 'AW',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      connection: dacpacConn,
      filterProfiles: [
        {
          ...filterProfiles[0],
          aiMetadata: {
            ...filterProfiles[0].aiMetadata,
            nodeVerdicts: [
              {
                nodeId: '[dbo].[FactSales]',
                verdict: 'analyze',
                futureVerdictField: 1,
              },
            ],
          },
        },
      ],
    };
    const parsed = ProjectReadSchema.safeParse(project);
    expect(parsed.success).toBe(true);
    const verdicts = parsed.success
      ? parsed.data.filterProfiles?.[0]?.aiMetadata?.nodeVerdicts
      : undefined;
    expect(verdicts).toEqual([
      { nodeId: '[dbo].[FactSales]', verdict: 'analyze' },
    ]);
  });

  it('parses a project record with no nodeVerdicts at all', () => {
    const project = {
      id: 'proj-2',
      name: 'AW',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      connection: dacpacConn,
      filterProfiles: [
        {
          id: 'view-2',
          name: 'Plain View',
          createdAt: '2026-01-01T00:00:00.000Z',
          filter: {
            schemas: [],
            types: [],
            hideIsolated: false,
            focusSchemas: [],
            showExternalRefs: true,
            externalRefTypes: [],
          },
          aiMetadata: baseAiMetadata,
        },
      ],
    };
    const parsed = ProjectReadSchema.safeParse(project);
    expect(parsed.success).toBe(true);
    expect(
      parsed.success &&
        parsed.data.filterProfiles?.[0]?.aiMetadata?.nodeVerdicts,
    ).toBeUndefined();
  });
});

describe('AIViewMetadata.columnAspect edge transforms', () => {
  const edge = {
    hopNode: '[dbo].[vwSales]',
    fromNode: '[dbo].[FactSales]',
    toNode: '[dbo].[vwSales]',
    fromCol: 'Amount',
    toCol: 'NetAmount',
  };
  const preview = (edges: unknown[]): unknown => ({
    type: 'ai-view-preview',
    name: 'Trace',
    nodeIds: ['[dbo].[vwSales]', '[dbo].[FactSales]'],
    aiMetadata: { ...baseAiMetadata, columnAspect: { edges } },
  });

  it('round-trips a multi-select classification through the strict write schema', () => {
    const parsed = ExtensionToWebviewMsgSchema.safeParse(
      preview([{ ...edge, transforms: ['aggregate', 'compute', 'filter'] }]),
    );
    expect(parsed.success).toBe(true);
    expect(
      parsed.success &&
        parsed.data.type === 'ai-view-preview' &&
        parsed.data.aiMetadata.columnAspect?.edges[0]?.transforms,
    ).toEqual(['aggregate', 'compute', 'filter']);
  });

  it('accepts an edge that carries no transforms at all', () => {
    const parsed = ExtensionToWebviewMsgSchema.safeParse(preview([edge]));
    expect(parsed.success).toBe(true);
    expect(
      parsed.success &&
        parsed.data.type === 'ai-view-preview' &&
        parsed.data.aiMetadata.columnAspect?.edges[0]?.transforms,
    ).toBeUndefined();
  });

  it('rejects an unrecognised transform value on the strict write schema', () => {
    expect(
      ExtensionToWebviewMsgSchema.safeParse(
        preview([{ ...edge, transforms: ['derive'] }]),
      ).success,
    ).toBe(false);
  });

  it('keeps a persisted project whose column-trace edge predates the classifier', () => {
    const project = {
      id: 'proj-3',
      name: 'AW',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      connection: dacpacConn,
      filterProfiles: [
        {
          id: 'view-3',
          name: 'CT View',
          createdAt: '2026-01-01T00:00:00.000Z',
          filter: {
            schemas: [],
            types: [],
            hideIsolated: false,
            focusSchemas: [],
            showExternalRefs: true,
            externalRefTypes: [],
          },
          aiMetadata: { ...baseAiMetadata, columnAspect: { edges: [edge] } },
        },
      ],
    };
    const parsed = ProjectReadSchema.safeParse(project);
    expect(parsed.success).toBe(true);
    const edges = parsed.success
      ? parsed.data.filterProfiles?.[0]?.aiMetadata?.columnAspect?.edges
      : undefined;
    expect(edges).toEqual([edge]);
  });

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
  const metadata = {
    ...baseAiMetadata,
    columnAspect: { edges: [], requested },
  };
  it('round-trips the descriptor through the strict preview boundary', () => {
    const preview = ExtensionToWebviewMsgSchema.safeParse({
      type: 'ai-view-preview',
      name: 'Trace',
      nodeIds: [requested.node],
      aiMetadata: metadata,
    });
    expect(preview.success).toBe(true);
    expect(
      preview.success &&
        preview.data.type === 'ai-view-preview' &&
        preview.data.aiMetadata.columnAspect,
    ).toEqual(metadata.columnAspect);
  });
  it('round-trips the descriptor through persisted project reading', () => {
    const saved = ProjectReadSchema.safeParse({
      id: 'project',
      name: 'AW',
      createdAt: baseAiMetadata.createdAt,
      updatedAt: baseAiMetadata.createdAt,
      connection: dacpacConn,
      filterProfiles: [
        {
          id: 'view',
          name: 'Trace',
          createdAt: baseAiMetadata.createdAt,
          filter: {
            schemas: [],
            types: [],
            hideIsolated: false,
            focusSchemas: [],
            showExternalRefs: true,
            externalRefTypes: [],
          },
          aiMetadata: metadata,
        },
      ],
    });
    expect(saved.success).toBe(true);
    expect(
      saved.success && saved.data.filterProfiles![0]?.aiMetadata?.columnAspect,
    ).toEqual(metadata.columnAspect);
  });
  it.each([
    { node: requested.node, columns: 'Value' },
    { node: requested.node, columns: ['Value'], extra: true },
    { columns: ['Value'] },
  ])('rejects a malformed descriptor: %j', (invalid) => {
    expect(
      ExtensionToWebviewMsgSchema.safeParse({
        type: 'ai-view-preview',
        name: 'Trace',
        nodeIds: [requested.node],
        aiMetadata: {
          ...baseAiMetadata,
          columnAspect: { edges: [], requested: invalid },
        },
      }).success,
    ).toBe(false);
  });
});
