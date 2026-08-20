/**
 * Tests for src/engine/projectStore.ts
 * Focus: Migration and Serialization (Core Data Integrity)
 */

import { describe, it, expect } from 'vitest';
import {
  addFilterProfile,
  createProject,
  migrateProjectStore,
  serializeFilter,
  deserializeFilter,
} from '../../../src/engine/projectStore';
import type {
  DacpacConnection,
  DatabaseConnection,
  FilterProfile,
  ProjectStoreDropReport,
  SerializedFilterState,
} from '../../../src/engine/projectStore';
import type { FilterState } from '../../../src/engine/types';
import {
  ExtensionToWebviewMsgSchema,
  MainPanelToExtensionMsgSchema,
  StoredConnectionInfoSchema,
} from '../../../src/engine/shared/bridgeContract';
import { stripSensitiveFields } from '../../../src/engine/connectionManager';
import type { IConnectionInfo } from '../../../src/types/mssql';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const dacpacConn: DacpacConnection = {
  type: 'dacpac',
  path: '/data/AdventureWorks.dacpac',
  displayName: 'AdventureWorks',
  schemas: ['dbo', 'Sales'],
};

const dbConn: DatabaseConnection = {
  type: 'database',
  connectionInfo: {
    server: 'myserver',
    database: 'SalesDB',
    user: 'sa',
    authenticationType: 'SqlLogin',
    port: 1433,
  },
  sourceName: 'SalesDB (myserver)',
  schemas: ['dbo', 'Sales'],
};

// ─── migrateProjectStore ──────────────────────────────────────────────────────

describe('migrateProjectStore', () => {
  it('returns empty store for invalid inputs', () => {
    for (const input of [
      null, undefined, 'string-value',
      { schemaVersion: 99, projects: [], lastOpenedId: null },
      { schemaVersion: 1, projects: 'oops', lastOpenedId: null },
    ]) {
      const s = migrateProjectStore(input);
      expect(s.schemaVersion, `schemaVersion 1 for ${JSON.stringify(input)}`).toBe(1);
      expect(s.projects.length, `no projects for ${JSON.stringify(input)}`).toBe(0);
    }
  });

  it('preserves valid v1 data for both connection types', () => {
    // Dacpac
    const projD = createProject('AW', dacpacConn);
    const sD = migrateProjectStore({ schemaVersion: 1, projects: [projD], lastOpenedId: projD.id });
    expect(sD.projects.length, 'dacpac: one project').toBe(1);
    expect(sD.projects[0].id, 'dacpac: id preserved').toBe(projD.id);
    expect(sD.lastOpenedId, 'dacpac: lastOpenedId preserved').toBe(projD.id);
    // Database
    const projDb = createProject('DB', dbConn);
    const sDb = migrateProjectStore({ schemaVersion: 1, projects: [projDb], lastOpenedId: null });
    expect(sDb.projects.length, 'database: one project').toBe(1);
    const c = sDb.projects[0].connection as DatabaseConnection;
    expect(c.sourceName, 'database: sourceName preserved').toBe(dbConn.sourceName);
  });

  it('filters out malformed project entries', () => {
    const valid = createProject('OK', dacpacConn);
    const badNoId = { name: 'Missing id', createdAt: 'x', updatedAt: 'x', connection: dacpacConn };
    const badConnType = { id: 'x', name: 'Bad conn', createdAt: 'x', updatedAt: 'x', connection: { type: 'ftp', host: 'foo' } };
    const badNoPath = { id: 'bad', name: 'Bad', createdAt: 'x', updatedAt: 'x', connection: { type: 'dacpac', displayName: 'AW', schemas: [] } };
    const raw = { schemaVersion: 1, projects: [valid, badNoId, badConnType, badNoPath], lastOpenedId: null };
    const s = migrateProjectStore(raw);
    expect(s.projects.length, 'only valid project retained').toBe(1);
    expect(s.projects[0].id, 'valid project preserved').toBe(valid.id);
  });

  it('preserves legacy Integrated-auth database project without user/port', () => {
    // Integrated/Entra records carry no SQL user and often no explicit port —
    // requiring them silently dropped persisted projects (regression, commit 2baaa650).
    const legacy = {
      id: 'legacy-int',
      name: 'Integrated DB',
      createdAt: 'x',
      updatedAt: 'x',
      connection: {
        type: 'database',
        connectionInfo: { server: 'corp-sql', database: 'Warehouse', authenticationType: 'Integrated' },
        sourceName: 'Warehouse (corp-sql)',
        schemas: ['dbo'],
      },
    };
    const s = migrateProjectStore({ schemaVersion: 1, projects: [legacy], lastOpenedId: 'legacy-int' });
    expect(s.projects.length, 'integrated-auth project survives').toBe(1);
    const c = s.projects[0].connection as DatabaseConnection;
    expect(c.connectionInfo.server, 'server preserved').toBe('corp-sql');
    expect(c.connectionInfo.user, 'user absent, not required').toBeUndefined();
    expect(c.connectionInfo.port, 'port absent, not required').toBeUndefined();
  });

  it('survives string-encoded port from older serializations', () => {
    // A string port must not drop the project; the schema coerces it to a number
    // (survival is the regression protection — a strict number check would have dropped it).
    const legacy = {
      id: 'str-port',
      name: 'String Port DB',
      createdAt: 'x',
      updatedAt: 'x',
      connection: {
        type: 'database',
        connectionInfo: { server: 'srv', database: 'DB', user: 'sa', authenticationType: 'SqlLogin', port: '1433' },
        sourceName: 'DB (srv)',
        schemas: ['dbo'],
      },
    };
    const s = migrateProjectStore({ schemaVersion: 1, projects: [legacy], lastOpenedId: null });
    expect(s.projects.length, 'string-port project survives validation').toBe(1);
    const c = s.projects[0].connection as DatabaseConnection;
    expect(c.connectionInfo.port, 'port coerced to number').toBe(1433);
  });

  it('keeps projects containing unknown connection fields, stripping the field', () => {
    const project = createProject('Unsafe', dbConn);
    const unsafe = {
      ...project,
      connection: {
        ...project.connection,
        connectionInfo: { ...dbConn.connectionInfo, password: 'secret' },
      },
    };
    const s = migrateProjectStore({ schemaVersion: 1, projects: [unsafe], lastOpenedId: null });
    // Rejecting the record would delete a saved project over a field an older build wrote. The
    // credential is removed instead, so it reaches neither memory nor the webview.
    expect(s.projects.length, 'project retained').toBe(1);
    const c = s.projects[0].connection as DatabaseConnection;
    expect(Object.keys(c.connectionInfo), 'unknown credential field stripped').not.toContain('password');
  });

  it('keeps a project whose connection carries the wider fields an older build persisted', () => {
    // 1.0.3 stored the connection by removing two known keys from the object the MSSQL extension
    // returned, so every other field that object carried was persisted too. Rejecting those
    // records deleted every live-database project on upgrade.
    const project = createProject('Legacy DB', dbConn);
    const wide = {
      ...project,
      connection: {
        ...project.connection,
        connectionInfo: {
          ...dbConn.connectionInfo,
          applicationName: 'vscode-mssql',
          connectTimeout: 30,
          multiSubnetFailover: false,
          persistSecurityInfo: true,
        },
      },
    };
    const s = migrateProjectStore({ schemaVersion: 1, projects: [wide], lastOpenedId: null });
    expect(s.projects.length, 'legacy live-database project survives upgrade').toBe(1);
    const c = s.projects[0].connection as DatabaseConnection;
    expect(c.connectionInfo.server, 'declared fields preserved').toBe(dbConn.connectionInfo.server);
    expect(Object.keys(c.connectionInfo), 'undeclared fields stripped').not.toContain('applicationName');
  });

  it('keeps a project whose saved views carry unknown keys at every nested level', () => {
    // 1.0.3 never validated filterProfiles at all. A saved view written by any build that added a
    // field must not cost the user the whole project — connection included — on read.
    const project = createProject('Views', dacpacConn);
    const withViews = {
      ...project,
      filterProfiles: [{
        id: 'view-1',
        name: 'AI View',
        createdAt: '2026-01-01T00:00:00.000Z',
        source: 'ai',
        filter: { ...serializeFilter(sampleFilter), futureFilterFlag: true },
        positions: { '[dbo].[FactSales]': { x: 1, y: 2, z: 3 } },
        viewport: { x: 0, y: 0, zoom: 1, futureViewportField: 'x' },
        aiMetadata: {
          createdAt: '2026-01-01T00:00:00.000Z',
          modelName: 'Test Model',
          highlightGroups: [{ label: 'Sources', color: 'source', nodeIds: ['[dbo].[FactSales]'], futureGroupField: 1 }],
          badges: [{ nodeId: '[dbo].[FactSales]', text: '1 Source', futureBadgeField: 1 }],
          notes: [{ nodeId: '[dbo].[FactSales]', text: 'note', futureNoteField: 1 }],
          columnAspect: {
            edges: [{
              hopNode: '[dbo].[FactSales]',
              fromNode: '[dbo].[DimDate]',
              toNode: '[dbo].[FactSales]',
              fromCol: 'DateKey',
              toCol: 'DateKey',
              futureEdgeField: 1,
            }],
          },
        },
      }],
    };
    const s = migrateProjectStore({ schemaVersion: 1, projects: [withViews], lastOpenedId: null });
    expect(s.projects.length, 'project with an unrecognised view field survives').toBe(1);
    const profile = s.projects[0].filterProfiles?.[0];
    expect(profile?.name, 'saved view retained').toBe('AI View');
    expect(profile?.positions?.['[dbo].[FactSales]'], 'position narrowed to declared fields').toEqual({ x: 1, y: 2 });
    expect(profile?.viewport, 'viewport narrowed to declared fields').toEqual({ x: 0, y: 0, zoom: 1 });
    expect(Object.keys(profile?.aiMetadata?.badges[0] ?? {}), 'badge fields stripped').toEqual(['nodeId', 'text']);
    expect(profile?.aiMetadata?.columnAspect?.edges[0].toCol, 'column-trace edge retained').toBe('DateKey');
  });

  it('drops project whose connectionInfo is not an object', () => {
    const malformed = {
      id: 'bad-ci',
      name: 'Malformed DB',
      createdAt: 'x',
      updatedAt: 'x',
      connection: { type: 'database', connectionInfo: 'not-an-object', sourceName: 'x', schemas: [] },
    };
    const valid = createProject('OK', dbConn);
    const s = migrateProjectStore({ schemaVersion: 1, projects: [malformed, valid], lastOpenedId: null });
    expect(s.projects.length, 'only the valid project retained').toBe(1);
    expect(s.projects[0].id, 'malformed connectionInfo dropped').toBe(valid.id);
  });
});

// ─── drop reporting ───────────────────────────────────────────────────────────

describe('migrateProjectStore drop reporting', () => {
  it('reports the dropped count and offending field paths', () => {
    const valid = createProject('OK', dacpacConn);
    const badNoId = { name: 'Missing id', createdAt: 'x', updatedAt: 'x', connection: dacpacConn };
    const leaked = {
      ...createProject('Unsafe', dbConn),
      connection: {
        ...createProject('Unsafe', dbConn).connection,
        connectionInfo: { ...dbConn.connectionInfo, password: 'secret' },
      },
    };
    const reports: ProjectStoreDropReport[] = [];
    const s = migrateProjectStore(
      { schemaVersion: 1, projects: [valid, badNoId, leaked], lastOpenedId: null },
      (report) => reports.push(report),
    );

    // Only the structurally invalid record is dropped: an unrecognized field is stripped, never a
    // reason to delete a saved project.
    expect(s.projects.length, 'valid and strippable projects retained').toBe(2);
    expect(reports.length, 'reported once for the whole store').toBe(1);
    expect(reports[0].dropped, 'only the record missing a required field counted').toBe(1);
    expect(reports[0].issuePaths, 'missing id reported by path').toContain('id');
    // Field names only — a report reaches the output channel and must never carry values.
    expect(reports[0].issuePaths.join('|'), 'no field values leaked').not.toContain('secret');
    const stripped = s.projects.find((p) => p.name === 'Unsafe');
    expect(
      Object.keys((stripped!.connection as DatabaseConnection).connectionInfo),
      'credential stripped from the retained record',
    ).not.toContain('password');
  });

  it('does not report when every project is valid', () => {
    const reports: ProjectStoreDropReport[] = [];
    const projects = [createProject('A', dacpacConn), createProject('B', dbConn)];
    const s = migrateProjectStore(
      { schemaVersion: 1, projects, lastOpenedId: null },
      (report) => reports.push(report),
    );

    expect(s.projects.length, 'both projects retained').toBe(2);
    expect(reports.length, 'callback not invoked').toBe(0);
  });

  it('reports records abandoned by an unknown schema version', () => {
    const reports: ProjectStoreDropReport[] = [];
    const s = migrateProjectStore(
      { schemaVersion: 99, projects: [createProject('A', dacpacConn)], lastOpenedId: null },
      (report) => reports.push(report),
    );

    expect(s.projects.length, 'store reset').toBe(0);
    expect(reports.length, 'abandonment reported').toBe(1);
    expect(reports[0].dropped, 'abandoned record counted').toBe(1);
    expect(reports[0].issuePaths, 'cause identified').toEqual(['schemaVersion']);
  });
});

describe('stripSensitiveFields → persisted shape', () => {
  // The mssql extension's real connection object is wider than the partial IConnectionInfo
  // declaration in this repo. When this function spread the unknown remainder, those keys were
  // written to the project store and the `.strict()` read schema then discarded the whole
  // project on the next load — silent loss of a saved database connection.
  const liveShapedConnection = {
    server: 'sql.example.net',
    database: 'AdventureWorks',
    authenticationType: 'Integrated',
    port: 1433,
    password: 'hunter2',
    connectionString: 'Server=sql.example.net;Password=hunter2',
    applicationName: 'vscode-mssql',
    connectTimeout: 30,
    persistSecurityInfo: true,
    multipleActiveResultSets: false,
  } as unknown as IConnectionInfo;

  it('drops secrets', () => {
    const stored = stripSensitiveFields(liveShapedConnection) as Record<string, unknown>;
    expect(stored.password).toBeUndefined();
    expect(stored.connectionString).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain('hunter2');
  });

  it('drops unknown runtime fields so the record stays readable', () => {
    const stored = stripSensitiveFields(liveShapedConnection) as Record<string, unknown>;
    for (const key of ['applicationName', 'connectTimeout', 'persistSecurityInfo', 'multipleActiveResultSets']) {
      expect(stored[key], `${key} must not be persisted`).toBeUndefined();
    }
  });

  it('round-trips through the strict read schema', () => {
    // The regression: this parse failed, so migrateProjectStore discarded the project.
    const parsed = StoredConnectionInfoSchema.safeParse(stripSensitiveFields(liveShapedConnection));
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
  });

  it('survives a full save-then-load cycle without dropping the project', () => {
    const project = createProject('Live', {
      type: 'database',
      connectionInfo: stripSensitiveFields(liveShapedConnection),
      sourceName: 'sql.example.net / AdventureWorks',
      schemas: ['dbo'],
    });
    let report: ProjectStoreDropReport | undefined;
    const store = migrateProjectStore(
      { schemaVersion: 1, projects: [project], lastOpenedId: project.id },
      (r) => { report = r; },
    );
    expect(report, 'no project may be dropped').toBeUndefined();
    expect(store.projects).toHaveLength(1);
  });

  it('preserves the fields that are worth keeping', () => {
    const stored = stripSensitiveFields(liveShapedConnection);
    expect(stored.server).toBe('sql.example.net');
    expect(stored.database).toBe('AdventureWorks');
    expect(stored.authenticationType).toBe('Integrated');
    expect(stored.port).toBe(1433);
  });

  it('fails at save time on a record the strict read side would drop', () => {
    // A server-scoped profile carries no database. Persisting it would succeed and the `.strict()`
    // read schema would then silently discard the whole project — the write path must throw instead.
    const serverScoped = {
      server: 'sql.example.net',
      authenticationType: 'Integrated',
    } as unknown as IConnectionInfo;
    expect(() => stripSensitiveFields(serverScoped)).toThrow();
  });
});

describe('project bridge contract', () => {
  it('preserves the complete current project shape in projects-list messages', () => {
    const project = createProject('AW', dacpacConn);
    const parsed = ExtensionToWebviewMsgSchema.parse({
      type: 'projects-list',
      projects: [project],
      lastOpenedId: project.id,
      lastWizardView: 'projects',
    });

    expect(parsed.type).toBe('projects-list');
    if (parsed.type !== 'projects-list') throw new Error('Expected projects-list message');
    expect(parsed.projects[0]).toEqual(project);
  });

  it('rejects save-project messages containing unknown connection fields', () => {
    const project = createProject('Unsafe', dbConn);
    const parsed = MainPanelToExtensionMsgSchema.safeParse({
      type: 'save-project',
      project: {
        ...project,
        connection: {
          ...project.connection,
          connectionInfo: { ...dbConn.connectionInfo, password: 'secret' },
        },
      },
    });

    expect(parsed.success).toBe(false);
  });
});

// ─── Bookmark view shape ──────────────────────────────────────────────────────

describe('bookmark view-shape fields', () => {
  const baseProfile = (extra: Partial<FilterProfile>): FilterProfile => ({
    id: 'view-1',
    name: 'Sales focus',
    createdAt: '2026-08-20T12:00:00.000Z',
    filter: {
      schemas: ['Sales'],
      types: ['table'],
      searchTerm: '',
      hideIsolated: false,
      focusSchemas: [],
      showExternalRefs: true,
      externalRefTypes: [],
    },
    ...extra,
  });

  it('a profile carrying the view shape round-trips through save, persistence read, and projects-list', () => {
    const profile = baseProfile({
      graphMode: 'overview',
      expandedSchemaView: { focusNodeId: null, expandedSchemas: ['Sales', 'dbo'] },
      showExpandedSchemaClusters: false,
    });

    const saved = MainPanelToExtensionMsgSchema.safeParse({ type: 'save-view', projectId: 'p1', profile });
    expect(saved.success).toBe(true);

    const project = createProject('AW', dacpacConn);
    const store = addFilterProfile(
      { schemaVersion: 1, projects: [project], lastOpenedId: project.id },
      project.id,
      profile,
    );
    const reloaded = migrateProjectStore(JSON.parse(JSON.stringify(store)));
    expect(reloaded.projects[0].filterProfiles?.[0]).toEqual(profile);

    const outbound = ExtensionToWebviewMsgSchema.safeParse({
      type: 'projects-list',
      projects: reloaded.projects,
      lastOpenedId: reloaded.lastOpenedId,
    });
    expect(outbound.success).toBe(true);
  });

  it('a 1.0.3-shaped profile without view-shape fields loads and re-saves unchanged', () => {
    const legacy = baseProfile({});
    const project = { ...createProject('AW', dacpacConn), filterProfiles: [legacy] };

    const reloaded = migrateProjectStore({ schemaVersion: 1, projects: [project], lastOpenedId: project.id });
    const restored = reloaded.projects[0].filterProfiles?.[0];
    expect(restored).toEqual(legacy);
    expect(restored).not.toHaveProperty('graphMode');
    expect(restored).not.toHaveProperty('expandedSchemaView');
    expect(restored).not.toHaveProperty('showExpandedSchemaClusters');

    const resaved = MainPanelToExtensionMsgSchema.safeParse({ type: 'save-view', projectId: project.id, profile: restored });
    expect(resaved.success).toBe(true);
  });
});

// ─── serializeFilter / deserializeFilter ──────────────────────────────────────

const sampleFilter: FilterState = {
  schemas: new Set(['dbo', 'Sales']),
  types: new Set(['table', 'view']),
  searchTerm: 'Order',
  hideIsolated: false,
  focusSchemas: new Set(['dbo']),
  showExternalRefs: true,
  externalRefTypes: new Set(['file']),
  exclusionPatterns: ['%tmp%', '^etl\\.'],
};

describe('serializeFilter / deserializeFilter', () => {
  it('roundtrip: serialize then deserialize preserves all fields', () => {
    const s = serializeFilter(sampleFilter);
    // Serialized form uses arrays
    expect(Array.isArray(s.schemas), 'schemas is array').toBe(true);
    expect(Array.isArray(s.types), 'types is array').toBe(true);
    // Roundtrip
    const restored = deserializeFilter(s);
    expect(restored.schemas instanceof Set, 'schemas restored to Set').toBe(true);
    expect(restored.types instanceof Set, 'types restored to Set').toBe(true);
    expect(restored.schemas.has('dbo'), 'dbo in schemas').toBe(true);
    expect(restored.schemas.has('Sales'), 'Sales in schemas').toBe(true);
    expect(restored.types.has('table'), 'table in types').toBe(true);
    expect(restored.searchTerm, 'searchTerm roundtrip').toBe('Order');
    expect(restored.hideIsolated, 'hideIsolated roundtrip').toBe(false);
    expect(restored.focusSchemas.has('dbo'), 'dbo in focusSchemas').toBe(true);
    expect(restored.showExternalRefs, 'showExternalRefs roundtrip').toBe(true);
    expect(restored.externalRefTypes.has('file'), 'file in externalRefTypes').toBe(true);
    expect(restored.exclusionPatterns.length, 'exclusionPatterns count').toBe(2);
    expect(restored.exclusionPatterns[0], 'first exclusionPattern').toBe('%tmp%');
  });

  it('deserializeFilter defaults exclusionPatterns when absent', () => {
    const s: SerializedFilterState = {
      schemas: ['dbo'], types: ['table'], searchTerm: '', hideIsolated: false,
      focusSchemas: [], showExternalRefs: true, externalRefTypes: [],
    };
    const restored = deserializeFilter(s);
    expect(restored.exclusionPatterns.length, 'defaults to empty array').toBe(0);
  });
});
