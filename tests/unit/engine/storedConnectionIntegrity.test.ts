/**
 * Pins the two contracts that keep a saved database project readable by the webview:
 * what may be persisted from a live connection object, and what may reach the `projects-list` frame.
 */

import { describe, it, expect, vi } from 'vitest';
import { stripSensitiveFields } from '../../../src/engine/connectionManager';
import { partitionSendableProjects } from '../../../src/bridge/messageHandlers';
import { migrateProjectStore } from '../../../src/engine/projectStore';
import { ExtensionToWebviewMsgSchema, type Project } from '../../../src/engine/shared/bridgeContract';

vi.mock('vscode', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback, inspect: () => undefined }) },
}));

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
  it('stripSensitiveFields keeps only declared fields, whatever the live object carries', () => {
    const narrowed = stripSensitiveFields({
      ...cleanConnectionInfo,
      azureAccountToken: 'token-value',
      password: 'never-persisted',
      applicationName: 'vscode-mssql',
    } as unknown as Record<string, unknown>);

    expect(narrowed).not.toHaveProperty('azureAccountToken');
    expect(narrowed).not.toHaveProperty('password');
    expect(narrowed).not.toHaveProperty('applicationName');
    expect(narrowed.server).toBe('localhost');
  });

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
    const legacy = dbProject({ ...cleanConnectionInfo, azureAccountToken: 'stale', applicationName: 'vscode-mssql' });
    const store = migrateProjectStore({ schemaVersion: 1, projects: [legacy], lastOpenedId: 'p-db' });

    expect(store.projects).toHaveLength(1);
    expect(JSON.stringify(store.projects[0])).not.toContain('azureAccountToken');
    const { sendable, rejected } = partitionSendableProjects(store.projects);
    expect(rejected).toHaveLength(0);
    expect(sendable).toHaveLength(1);
  });
});
