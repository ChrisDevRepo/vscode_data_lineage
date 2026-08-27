/**
 * Per-node CT verdict field on `AIViewMetadata.nodeVerdicts` (host-wire package P2).
 *
 * @remarks
 * Proves the field round-trips through the strict write schema used to send `ai-view-preview`
 * frames to the webview, and that the tolerant read schema used for persisted project records
 * keeps a record whose `nodeVerdicts` entries carry a field this build never declared — the same
 * forward-compatibility guarantee already covered for `badges`/`columnAspect` in
 * `projectStore.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import {
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
    expect(parsed.success && parsed.data.type === 'ai-view-preview' && parsed.data.aiMetadata.nodeVerdicts)
      .toEqual(msg.aiMetadata.nodeVerdicts);
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
    const filterProfiles: FilterProfile[] = [{
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
    }];
    const project = {
      id: 'proj-1',
      name: 'AW',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      connection: dacpacConn,
      filterProfiles: [{
        ...filterProfiles[0],
        aiMetadata: {
          ...filterProfiles[0].aiMetadata,
          nodeVerdicts: [{ nodeId: '[dbo].[FactSales]', verdict: 'analyze', futureVerdictField: 1 }],
        },
      }],
    };
    const parsed = ProjectReadSchema.safeParse(project);
    expect(parsed.success).toBe(true);
    const verdicts = parsed.success ? parsed.data.filterProfiles?.[0]?.aiMetadata?.nodeVerdicts : undefined;
    expect(verdicts).toEqual([{ nodeId: '[dbo].[FactSales]', verdict: 'analyze' }]);
  });

  it('parses a project record with no nodeVerdicts at all', () => {
    const project = {
      id: 'proj-2',
      name: 'AW',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      connection: dacpacConn,
      filterProfiles: [{
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
      }],
    };
    const parsed = ProjectReadSchema.safeParse(project);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.filterProfiles?.[0]?.aiMetadata?.nodeVerdicts).toBeUndefined();
  });
});
