/**
 * Pins the built-in connection settings: schema and tolerant read, the no-password contract,
 * and the add / remove / update-password commands with their secret-store side effects.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const host = vi.hoisted(() => ({
  stored: undefined as unknown,
  updates: [] as Array<{ key: string; value: unknown; target: unknown }>,
  handlers: new Map<string, (...args: any[]) => any>(),
  showInputBox: vi.fn(),
  showQuickPick: vi.fn(),
  createInputBox: vi.fn(),
  createQuickPick: vi.fn(),
  showWarningMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  withProgress: vi.fn(),
}));

vi.mock('vscode', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>();
  return {
    ...actual,
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    ProgressLocation: { Notification: 15 },
    QuickInputButtons: { Back: { iconPath: 'back' } },
    commands: {
      registerCommand: (id: string, fn: (...args: any[]) => any) => { host.handlers.set(id, fn); return { dispose: () => host.handlers.delete(id) }; },
      executeCommand: vi.fn(),
    },
    window: {
      showInputBox: (...a: unknown[]) => host.showInputBox(...a),
      showQuickPick: (...a: unknown[]) => host.showQuickPick(...a),
      createInputBox: (...a: unknown[]) => host.createInputBox(...a),
      createQuickPick: (...a: unknown[]) => host.createQuickPick(...a),
      showWarningMessage: (...a: unknown[]) => host.showWarningMessage(...a),
      showInformationMessage: (...a: unknown[]) => host.showInformationMessage(...a),
      showErrorMessage: (...a: unknown[]) => host.showErrorMessage(...a),
      withProgress: (...a: unknown[]) => host.withProgress(...a),
    },
    workspace: {
      getConfiguration: () => ({
        get: (_k: string, d: unknown) => host.stored ?? d,
        inspect: () => ({ globalValue: host.stored }),
        update: async (key: string, value: unknown, target: unknown) => { host.updates.push({ key, value, target }); host.stored = value; },
      }),
    },
  };
});

const {
  BuiltInConnectionSchema, readBuiltInConnections, passwordSecretKey,
} = await import('../../../../src/engine/db/connectionSettings');
const { registerConnectionCommands } = await import('../../../../src/engine/db/connectionCommands');

const outputChannel = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() } as never;

function makeContext() {
  const secrets = { get: vi.fn(), store: vi.fn(async () => {}), delete: vi.fn(async () => {}) };
  return { context: { secrets, subscriptions: [] } as never, secrets };
}

const valid = {
  id: '3f2b8c1e-5d34-4e0a-9a41-2b7c9d1e8f60', name: 'Local', server: 'localhost', port: 1433, database: 'AdventureWorks',
  authenticationType: 'sqlLogin', user: 'sa',
};

beforeEach(() => {
  host.stored = undefined;
  host.updates.length = 0;
  host.handlers.clear();
  for (const fn of [host.showInputBox, host.showQuickPick, host.createInputBox, host.createQuickPick, host.showWarningMessage, host.showInformationMessage, host.showErrorMessage, host.withProgress]) fn.mockReset();
});

describe('BuiltInConnectionSchema', () => {
  it('accepts a full SQL login entry and a minimal Entra entry', () => {
    expect(BuiltInConnectionSchema.safeParse(valid).success).toBe(true);
    expect(BuiltInConnectionSchema.safeParse({
      id: 'b0f3a1c2-0000-4000-8000-000000000001', name: 'Cloud', server: 'x.database.windows.net', authenticationType: 'entraId', tenantId: 't',
    }).success).toBe(true);
  });

  it('rejects an unknown authentication type, an out-of-range port and an empty server', () => {
    expect(BuiltInConnectionSchema.safeParse({ ...valid, authenticationType: 'kerberos' }).success).toBe(false);
    expect(BuiltInConnectionSchema.safeParse({ ...valid, port: 70000 }).success).toBe(false);
    expect(BuiltInConnectionSchema.safeParse({ ...valid, server: '' }).success).toBe(false);
  });

  it('never carries a password property through a parse', () => {
    const parsed = BuiltInConnectionSchema.parse({ ...valid, password: 'leaked' });
    expect(parsed).not.toHaveProperty('password');
  });
});

describe('readBuiltInConnections', () => {
  it('returns valid entries, drops invalid ones with a debug log, and strips a stray password', () => {
    const debug = vi.fn();
    host.stored = [
      { ...valid, password: 'leaked' },
      { id: 'x', name: 'broken' },
      'not-an-object',
    ];
    const result = readBuiltInConnections({ debug } as never);
    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty('password');
    expect(result[0].name).toBe('Local');
    expect(debug).toHaveBeenCalled();
    expect(JSON.stringify(debug.mock.calls)).not.toContain('leaked');
  });

  it('returns an empty list when the setting is absent or not an array', () => {
    expect(readBuiltInConnections()).toEqual([]);
    host.stored = { nope: true };
    expect(readBuiltInConnections()).toEqual([]);
  });
});

describe('connection commands', () => {
  it('registers the four commands', () => {
    const { context } = makeContext();
    registerConnectionCommands(context, outputChannel, async () => []);
    expect([...host.handlers.keys()].sort()).toEqual([
      'dataLineageViz.addDatabaseConnection',
      'dataLineageViz.editDatabaseConnection',
      'dataLineageViz.removeDatabaseConnection',
      'dataLineageViz.updateDatabasePassword',
    ]);
  });

  it('addDatabaseConnection with arguments saves to user settings and the secret store without a prompt', async () => {
    const { context, secrets } = makeContext();
    registerConnectionCommands(context, outputChannel, async () => []);
    const { id: _ignored, ...withoutId } = valid;

    const id = await host.handlers.get('dataLineageViz.addDatabaseConnection')!({ connection: withoutId, password: 's3cret' });

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(host.updates).toHaveLength(1);
    expect(host.updates[0]).toMatchObject({ key: 'connections', target: 1 });
    const saved = host.updates[0].value as Array<Record<string, unknown>>;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id, server: 'localhost', authenticationType: 'sqlLogin', user: 'sa' });
    expect(JSON.stringify(saved)).not.toContain('s3cret');
    expect(secrets.store).toHaveBeenCalledWith(passwordSecretKey(id), 's3cret');
    for (const prompt of [host.showInputBox, host.showQuickPick, host.createInputBox, host.createQuickPick, host.withProgress]) {
      expect(prompt).not.toHaveBeenCalled();
    }
  });

  it('addDatabaseConnection keeps a supplied id and replaces the entry with that id', async () => {
    host.stored = [valid, { ...valid, id: 'other-id', name: 'Other' }];
    const { context } = makeContext();
    registerConnectionCommands(context, outputChannel, async () => []);

    const id = await host.handlers.get('dataLineageViz.addDatabaseConnection')!({ connection: { ...valid, name: 'Renamed' } });

    expect(id).toBe(valid.id);
    const saved = host.updates[0].value as Array<Record<string, unknown>>;
    expect(saved.map((c) => c.name).sort()).toEqual(['Other', 'Renamed']);
  });

  it('addDatabaseConnection rejects arguments that fail validation and writes nothing', async () => {
    const { context, secrets } = makeContext();
    registerConnectionCommands(context, outputChannel, async () => []);

    await expect(host.handlers.get('dataLineageViz.addDatabaseConnection')!({ connection: { name: 'x' }, password: 'p' }))
      .rejects.toThrow(/connection/i);
    expect(host.updates).toHaveLength(0);
    expect(secrets.store).not.toHaveBeenCalled();
  });

  it('addDatabaseConnection refuses a password key inside the connection object', async () => {
    const { context, secrets } = makeContext();
    registerConnectionCommands(context, outputChannel, async () => []);

    const id = await host.handlers.get('dataLineageViz.addDatabaseConnection')!({ connection: { ...valid, password: 'inline' } });

    expect(JSON.stringify(host.updates)).not.toContain('inline');
    expect(secrets.store).not.toHaveBeenCalled();
    expect(id).toBe(valid.id);
  });

  it('removeDatabaseConnection deletes the entry and its secret', async () => {
    host.stored = [valid, { ...valid, id: 'keep-me', name: 'Keep' }];
    const { context, secrets } = makeContext();
    registerConnectionCommands(context, outputChannel, async () => []);

    await host.handlers.get('dataLineageViz.removeDatabaseConnection')!(valid.id);

    const saved = host.updates[0].value as Array<Record<string, unknown>>;
    expect(saved.map((c) => c.id)).toEqual(['keep-me']);
    expect(secrets.delete).toHaveBeenCalledWith(passwordSecretKey(valid.id));
  });

  it('updateDatabasePassword stores the typed password under the connection secret key', async () => {
    host.stored = [valid];
    host.showInputBox.mockResolvedValue('new-pw');
    const { context, secrets } = makeContext();
    registerConnectionCommands(context, outputChannel, async () => []);

    await host.handlers.get('dataLineageViz.updateDatabasePassword')!(valid.id);

    expect(host.showInputBox.mock.calls[0][0]).toMatchObject({ password: true });
    expect(secrets.store).toHaveBeenCalledWith(passwordSecretKey(valid.id), 'new-pw');
  });
});

describe('passwordSecretKey', () => {
  it('namespaces the secret by connection id', () => {
    expect(passwordSecretKey('abc')).toBe('dataLineageViz.database.password.abc');
  });
});
