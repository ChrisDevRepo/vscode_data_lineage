/**
 * Pins the two contracts that keep a saved database project readable by the webview:
 * what may reach the mssql extension, and what may reach the `projects-list` frame.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { connectDirect, stripSensitiveFields } from '../../../src/engine/connectionManager';
import { partitionSendableProjects } from '../../../src/bridge/messageHandlers';
import { migrateProjectStore } from '../../../src/engine/projectStore';
import { ExtensionToWebviewMsgSchema, type Project } from '../../../src/engine/shared/bridgeContract';
import type { IConnectionInfo } from '../../../src/types/mssql';

const MSSQL_EXTENSION_ID = 'ms-mssql.mssql';

const outputChannel = {
  debug() {}, info() {}, warn() {}, error() {}, trace() {}, append() {}, appendLine() {},
} as unknown as vscode.LogOutputChannel;

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
  beforeEach(() => {
    (vscode as unknown as { extensions: { reset(): void } }).extensions.reset();
  });

  it('connectDirect hands the mssql extension a clone, so a mutated profile cannot reach the saved record', async () => {
    const stored = { ...cleanConnectionInfo } as unknown as IConnectionInfo;
    let received: Record<string, unknown> | undefined;
    (vscode as unknown as { extensions: { registry: Map<string, unknown> } }).extensions.registry.set(MSSQL_EXTENSION_ID, {
      isActive: true,
      packageJSON: { version: '1.34.0' },
      exports: {
        // An Entra connection observably comes back carrying an acquired token on the profile it
        // was given; this fake reproduces that write.
        connect(profile: Record<string, unknown>) {
          received = profile;
          profile.azureAccountToken = 'token-value';
          return Promise.resolve('uri://connection');
        },
      },
    });

    const result = await connectDirect(stored, outputChannel);

    expect(result?.connectionUri).toBe('uri://connection');
    expect(received).not.toBe(stored);
    expect(stored).not.toHaveProperty('azureAccountToken');
    expect(Object.keys(stored).sort()).toEqual(Object.keys(cleanConnectionInfo).sort());
  });

  it('stripSensitiveFields keeps only declared fields, whatever the live object carries', () => {
    const narrowed = stripSensitiveFields({
      ...cleanConnectionInfo,
      azureAccountToken: 'token-value',
      password: 'never-persisted',
      applicationName: 'vscode-mssql',
    } as unknown as IConnectionInfo);

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
    // The summary must name the offending field; its surrounding wording is the summariser's own.
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
