/** Pins the two contracts that keep a saved database project readable by the webview: what may reach the `projects-list` frame and how legacy connections migrate. */

import { describe, it, expect } from 'vitest';
import { partitionSendableProjects } from '../../../src/bridge/messageHandlers';
import { migrateProjectStore } from '../../../src/engine/projectStore';
import { ExtensionToWebviewMsgSchema, type Project } from '../../../src/engine/shared/bridgeContract';

function dbProject(connectionInfo: Record<string, unknown>): Project {
  return {
    id: 'p-db',
    name: 'localhost / AdventureWorks2025',
    createdAt: '2026-08-20T11:12:00.000Z',
    updatedAt: '2026-08-20T11:12:00.000Z',
    connection: {
      type: 'database',
      sourceName: 'localhost / AdventureWorks2025',
      schemas: ['Sales'],
      connectionInfo: connectionInfo as never,
    },
  };
}

const cleanConnectionInfo = {
  server: 'localhost',
  database: 'AdventureWorks2025',
  authenticationType: 'AzureMFA',
  encrypt: true,
  trustServerCertificate: true,
};

describe('stored connection integrity', () => {
  it('one unsendable project no longer costs the whole projects-list frame', () => {
    const good = dbProject(cleanConnectionInfo);
    const bad = { ...dbProject({ ...cleanConnectionInfo, azureAccountToken: 'token-value' }), id: 'p-bad' };
    const dacpac = {
      id: 'p-dacpac', name: 'Warehouse', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
      connection: { type: 'dacpac', path: 'c:/wh.dacpac', displayName: 'wh.dacpac', schemas: [] },
    } as Project;

    const { sendable, rejected } = partitionSendableProjects([good, bad, dacpac]);

    expect(sendable.map(p => p.id)).toEqual(['p-db', 'p-dacpac']);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].id).toBe('p-bad');
    expect(rejected[0].issues).toContain('azureAccountToken');
    expect(
      ExtensionToWebviewMsgSchema.safeParse({ type: 'projects-list', projects: sendable, lastOpenedId: 'p-db' }).success,
    ).toBe(true);
  });

  it('a record written by an older build still loads and reaches the view', () => {
    const legacy = dbProject({ ...cleanConnectionInfo, provider: 'mssqlExtension', azureAccountToken: 'stale', applicationName: 'vscode-mssql' });
    const store = migrateProjectStore({ schemaVersion: 1, projects: [legacy], lastOpenedId: 'p-db' });

    expect(store.projects).toHaveLength(1);
    expect(store.projects[0].connection).toMatchObject({ connectionInfo: cleanConnectionInfo });
    expect(JSON.stringify(store.projects[0])).not.toContain('provider');
    expect(ExtensionToWebviewMsgSchema.safeParse({ type: 'projects-list', projects: [dbProject({ ...cleanConnectionInfo, provider: 'mssqlExtension' })], lastOpenedId: 'p-db' }).success).toBe(false);
    expect(JSON.stringify(store.projects[0])).not.toContain('azureAccountToken');
    const { sendable, rejected } = partitionSendableProjects(store.projects);
    expect(rejected).toHaveLength(0);
    expect(sendable).toHaveLength(1);
  });
});
