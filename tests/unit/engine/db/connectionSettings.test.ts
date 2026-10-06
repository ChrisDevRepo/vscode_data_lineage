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
  getSession: vi.fn(),
  openBuiltInSession: vi.fn(),
  tenants: [] as Array<{ tenantId: string; displayName: string }>,
  /** When set, a settings write lands only after a macrotask, as VS Code's file-backed write does. */
  deferWrites: false,
  /** When set, the next settings write rejects. */
  failNextWrite: false,
}));

vi.mock('@microsoft/vscode-azext-azureauth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  VSCodeAzureSubscriptionProvider: class { async getTenants() { return host.tenants; } },
}));

vi.mock('vscode', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>();
  return {
    ...actual,
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    ProgressLocation: { Notification: 15 },
    QuickInputButtons: { Back: { iconPath: 'back' } },
    authentication: { getSession: (...a: unknown[]) => host.getSession(...a) },
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
        update: async (key: string, value: unknown, target: unknown) => {
          if (host.deferWrites) await new Promise((resolve) => setTimeout(resolve, 0));
          if (host.failNextWrite) { host.failNextWrite = false; throw new Error('settings write failed'); }
          host.updates.push({ key, value, target });
          host.stored = value;
        },
      }),
    },
  };
});

vi.mock('../../../../src/engine/db/builtInProvider', () => ({
  openBuiltInSession: (...a: unknown[]) => host.openBuiltInSession(...a),
}));

const {
  BuiltInConnectionSchema, readBuiltInConnections, passwordSecretKey, encodeSavedPassword, readSavedPassword, savePassword,
  upsertBuiltInConnection, deleteBuiltInConnection,
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
  host.tenants = [];
  host.deferWrites = false;
  host.failNextWrite = false;
  host.handlers.clear();
  for (const fn of [host.showInputBox, host.showQuickPick, host.createInputBox, host.createQuickPick, host.showWarningMessage, host.showInformationMessage, host.showErrorMessage, host.withProgress, host.getSession, host.openBuiltInSession]) fn.mockReset();
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
    expect(secrets.store).toHaveBeenCalledWith(passwordSecretKey(id), encodeSavedPassword({ ...valid, id }, 's3cret'));
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

  it('addDatabaseConnection keeps hand-edited entries it cannot read, unchanged', async () => {
    const handEdited = { id: 'typo-id', name: 'Typo', server: 'db2', authenticationType: 'sqllogin', user: 'u' };
    host.stored = [valid, handEdited];
    const { context } = makeContext();
    registerConnectionCommands(context, outputChannel, async () => []);

    await host.handlers.get('dataLineageViz.addDatabaseConnection')!({ connection: { ...valid, id: 'new-id', name: 'New' } });

    const saved = host.updates[0].value as Array<Record<string, unknown>>;
    expect(saved).toEqual([valid, handEdited, expect.objectContaining({ id: 'new-id' })]);
  });

  it('removeDatabaseConnection keeps hand-edited entries it cannot read, unchanged', async () => {
    const handEdited = { id: 'typo-id', name: 'Typo', server: 'db2', port: 0, authenticationType: 'sqlLogin' };
    host.stored = [valid, handEdited];
    host.showWarningMessage.mockResolvedValueOnce('Remove');
    const { context } = makeContext();
    registerConnectionCommands(context, outputChannel, async () => []);

    await host.handlers.get('dataLineageViz.removeDatabaseConnection')!(valid.id);

    expect(host.updates[0].value).toEqual([handEdited]);
  });

  it('addDatabaseConnection rejects an oversized field or password and writes nothing', async () => {
    const { context, secrets } = makeContext();
    registerConnectionCommands(context, outputChannel, async () => []);
    const huge = 'x'.repeat(1024 * 1024);
    const add = host.handlers.get('dataLineageViz.addDatabaseConnection')!;

    for (const field of ['id', 'name', 'server', 'user', 'database', 'tenantId']) {
      await expect(add({ connection: { ...valid, [field]: huge } })).rejects.toThrow(/connection/i);
    }
    await expect(add({ connection: valid, password: huge })).rejects.toThrow(/connection/i);
    expect(host.updates).toHaveLength(0);
    expect(secrets.store).not.toHaveBeenCalled();
  });

  it('removeDatabaseConnection deletes the entry and its secret', async () => {
    host.stored = [valid, { ...valid, id: 'keep-me', name: 'Keep' }];
    host.showWarningMessage.mockResolvedValueOnce('Remove');
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
    expect(secrets.store).toHaveBeenCalledWith(passwordSecretKey(valid.id), encodeSavedPassword(valid as never, 'new-pw'));
  });

  it('updateDatabasePassword refuses an Entra ID connection named by id without prompting or storing', async () => {
    const entraEntry = { id: 'e1', name: 'Cloud', server: 'x.database.windows.net', authenticationType: 'entraId' };
    host.stored = [entraEntry];
    const { context, secrets } = makeContext();
    registerConnectionCommands(context, outputChannel, async () => []);

    const stored = await host.handlers.get('dataLineageViz.updateDatabasePassword')!(entraEntry.id);

    expect(stored).toBe(false);
    expect(host.showInputBox).not.toHaveBeenCalled();
    expect(secrets.store).not.toHaveBeenCalled();
    expect(host.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(String(host.showWarningMessage.mock.calls[0][0])).toMatch(/"Cloud".*Microsoft Entra ID.*no password/i);
  });
});

describe('connection list writes', () => {
  const second = { ...valid, id: 'b0f3a1c2-0000-4000-8000-000000000002', name: 'Second' };

  it('two concurrent upserts both survive', async () => {
    host.deferWrites = true;

    await Promise.all([upsertBuiltInConnection(valid as never), upsertBuiltInConnection(second as never)]);

    expect((host.stored as Array<{ id: string }>).map((c) => c.id)).toEqual([valid.id, second.id]);
  });

  it('a delete issued alongside an upsert sees the upserted entry', async () => {
    host.stored = [valid];
    host.deferWrites = true;

    await Promise.all([upsertBuiltInConnection(second as never), deleteBuiltInConnection(valid.id)]);

    expect((host.stored as Array<{ id: string }>).map((c) => c.id)).toEqual([second.id]);
  });

  it('a failed write rejects its caller and the next write still runs', async () => {
    host.failNextWrite = true;

    const failed = upsertBuiltInConnection(valid as never);
    const next = upsertBuiltInConnection(second as never);

    await expect(failed).rejects.toThrow(/settings write failed/);
    await expect(next).resolves.toBeUndefined();
    expect((host.stored as Array<{ id: string }>).map((c) => c.id)).toEqual([second.id]);
  });
});

describe('addDatabaseConnection asks before trusting a server certificate', () => {
  const add = (arg: unknown) => host.handlers.get('dataLineageViz.addDatabaseConnection')!(arg);
  const savedEntry = () => (host.updates.at(-1)!.value as Array<Record<string, unknown>>)[0];
  const register = () => registerConnectionCommands(makeContext().context, outputChannel, async () => []);

  it('saves trust when the user confirms the modal', async () => {
    host.showWarningMessage.mockResolvedValue('Trust Certificate');
    register();
    await add({ connection: { ...valid, trustServerCertificate: true } });
    expect(host.showWarningMessage.mock.calls[0][1]).toEqual({ modal: true });
    expect(savedEntry().trustServerCertificate).toBe(true);
  });

  it('saves the connection without trust when the user declines', async () => {
    host.showWarningMessage.mockResolvedValue(undefined);
    register();
    await add({ connection: { ...valid, trustServerCertificate: true } });
    expect(savedEntry()).toMatchObject({ id: valid.id, trustServerCertificate: false });
  });

  it('does not ask again for a server already trusted under the same id', async () => {
    host.stored = [{ ...valid, trustServerCertificate: true }];
    register();
    await add({ connection: { ...valid, name: 'Renamed', trustServerCertificate: true } });
    expect(host.showWarningMessage).not.toHaveBeenCalled();
    expect(savedEntry()).toMatchObject({ name: 'Renamed', trustServerCertificate: true });
  });

  it('asks again when a trusted id moves to another server', async () => {
    host.stored = [{ ...valid, trustServerCertificate: true }];
    host.showWarningMessage.mockResolvedValue(undefined);
    register();
    await add({ connection: { ...valid, server: 'other', trustServerCertificate: true } });
    expect(host.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(savedEntry()).toMatchObject({ server: 'other', trustServerCertificate: false });
  });

  it('does not ask when the argument leaves trust off', async () => {
    register();
    await add({ connection: valid });
    expect(host.showWarningMessage).not.toHaveBeenCalled();
  });
});

describe('saved password follows the server it was entered for', () => {
  const trusted = { ...valid, trustServerCertificate: true };
  const key = passwordSecretKey(valid.id);
  const add = (arg: unknown) => host.handlers.get('dataLineageViz.addDatabaseConnection')!(arg);

  it('addDatabaseConnection deletes the saved password when an existing id moves to another server', async () => {
    host.stored = [valid];
    const { context, secrets } = makeContext();
    registerConnectionCommands(context, outputChannel, async () => []);

    await add({ connection: { ...valid, server: 'other' } });

    expect(secrets.delete).toHaveBeenCalledWith(key);
    expect(secrets.store).not.toHaveBeenCalled();
  });

  it.each([
    ['port', { port: 1444 }],
    ['user', { user: 'other' }],
    ['authentication type', { authenticationType: 'entraId', user: undefined }],
  ])('addDatabaseConnection deletes the saved password when the %s changes', async (_label, patch) => {
    host.stored = [valid];
    const { context, secrets } = makeContext();
    registerConnectionCommands(context, outputChannel, async () => []);

    await add({ connection: { ...valid, ...patch } });

    expect(secrets.delete).toHaveBeenCalledWith(key);
  });

  it('addDatabaseConnection deletes a saved password whose previous entry could not be read', async () => {
    host.stored = [{ ...valid, port: 'not-a-port' }];
    const { context, secrets } = makeContext();
    registerConnectionCommands(context, outputChannel, async () => []);

    await add({ connection: { ...valid, server: 'other' } });

    expect(secrets.delete).toHaveBeenCalledWith(key);
  });

  it('addDatabaseConnection stores the supplied password instead when the server changes', async () => {
    host.stored = [valid];
    const { context, secrets } = makeContext();
    registerConnectionCommands(context, outputChannel, async () => []);

    await add({ connection: { ...valid, server: 'other' }, password: 'fresh' });

    expect(secrets.store).toHaveBeenCalledWith(key, encodeSavedPassword({ ...valid, server: 'other' } as never, 'fresh'));
    expect(secrets.delete).not.toHaveBeenCalled();
  });

  it('addDatabaseConnection keeps the saved password when only the name changes', async () => {
    host.stored = [valid];
    const { context, secrets } = makeContext();
    registerConnectionCommands(context, outputChannel, async () => []);

    await add({ connection: { ...valid, name: 'Renamed' } });

    expect(secrets.delete).not.toHaveBeenCalled();
  });

  it('removeDatabaseConnection always asks first, also when called with an id', async () => {
    host.stored = [valid];
    host.showWarningMessage.mockResolvedValueOnce(undefined);
    const { context, secrets } = makeContext();
    registerConnectionCommands(context, outputChannel, async () => []);

    await host.handlers.get('dataLineageViz.removeDatabaseConnection')!(valid.id);

    expect(host.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining(valid.name), { modal: true }, 'Remove');
    expect(host.updates).toHaveLength(0);
    expect(secrets.delete).not.toHaveBeenCalled();
  });

  interface Step { values?: string[]; pick?: string }

  function scriptWizard(steps: Step[]) {
    const prompts: string[] = [];
    const rejected: string[] = [];
    let at = 0;
    const listeners = () => {
      const on: Record<string, (...a: any[]) => void> = {};
      const reg = (name: string) => (fn: (...a: any[]) => void) => { on[name] = fn; return { dispose() {} }; };
      return { on, reg };
    };
    host.createInputBox.mockImplementation(() => {
      const { on, reg } = listeners();
      const box: Record<string, any> = {
        value: '', validationMessage: undefined, dispose() {},
        onDidTriggerButton: reg('button'), onDidHide: reg('hide'), onDidAccept: reg('accept'),
        show() {
          prompts.push(String(box.prompt));
          const step = steps[at++];
          for (const value of step.values ?? []) {
            box.value = value;
            box.validationMessage = undefined;
            on.accept();
            if (box.validationMessage === undefined) return;
            rejected.push(String(box.validationMessage));
          }
        },
      };
      return box;
    });
    host.createQuickPick.mockImplementation(() => {
      const { on, reg } = listeners();
      const box: Record<string, any> = {
        items: [], selectedItems: [], dispose() {},
        onDidTriggerButton: reg('button'), onDidHide: reg('hide'), onDidAccept: reg('accept'),
        show() {
          const step = steps[at++];
          box.selectedItems = [box.items.find((i: { label: string }) => i.label === step.pick)];
          on.accept();
        },
      };
      return box;
    });
    return { prompts, rejected };
  }

  function editWith(steps: Step[]) {
    host.withProgress.mockImplementation((_options: unknown, task: () => unknown) => task());
    host.openBuiltInSession.mockResolvedValue({ dispose: async () => {} });
    const wizard = scriptWizard(steps);
    const { context, secrets } = makeContext();
    registerConnectionCommands(context, outputChannel, async () => []);
    const run = () => host.handlers.get('dataLineageViz.editDatabaseConnection')!(valid.id);
    return { wizard, secrets, run };
  }

  it('edit wizard resets certificate trust and requires a password when the server changes', async () => {
    host.stored = [trusted];
    const { wizard, secrets, run } = editWith([
      { values: ['other,1433'] }, { pick: 'SQL Login' }, { values: ['sa'] }, { values: ['', 'fresh'] },
      { values: ['AdventureWorks'] }, { values: ['Moved'] },
    ]);

    await run();

    expect(wizard.rejected).toEqual(['A password is required.']);
    expect(wizard.prompts.find((p) => /Password/.test(p))).not.toMatch(/keep/i);
    const saved = (host.updates.at(-1)!.value as Array<Record<string, unknown>>)[0];
    expect(saved).toMatchObject({ server: 'other', name: 'Moved' });
    expect(saved.trustServerCertificate).not.toBe(true);
    expect(secrets.store).toHaveBeenCalledWith(passwordSecretKey(valid.id), encodeSavedPassword({ ...valid, server: 'other' } as never, 'fresh'));
  });

  it('edit wizard requires a password when only the port changes', async () => {
    host.stored = [trusted];
    const { wizard, run } = editWith([
      { values: ['localhost,1444'] }, { pick: 'SQL Login' }, { values: ['sa'] }, { values: ['', 'fresh'] },
      { values: ['AdventureWorks'] }, { values: ['Moved'] },
    ]);

    await run();

    expect(wizard.rejected).toEqual(['A password is required.']);
    const saved = (host.updates.at(-1)!.value as Array<Record<string, unknown>>)[0];
    expect(saved.trustServerCertificate).not.toBe(true);
  });

  it('edit wizard keeps the saved password and trust when the server is unchanged', async () => {
    host.stored = [trusted];
    const { wizard, secrets, run } = editWith([
      { values: ['localhost,1433'] }, { pick: 'SQL Login' }, { values: ['sa'] }, { values: [''] },
      { values: ['AdventureWorks'] }, { values: ['Renamed'] },
    ]);

    await run();

    expect(wizard.rejected).toEqual([]);
    expect(wizard.prompts.find((p) => /Password/.test(p))).toMatch(/keep/i);
    const saved = (host.updates.at(-1)!.value as Array<Record<string, unknown>>)[0];
    expect(saved.trustServerCertificate).toBe(true);
    expect(secrets.store).not.toHaveBeenCalled();
    expect(secrets.delete).not.toHaveBeenCalled();
  });

  it('edit wizard rejects blank database names before saving a required name', async () => {
    host.stored = [valid];
    const { wizard, run } = editWith([
      { values: ['localhost,1433'] }, { pick: 'SQL Login' }, { values: ['sa'] }, { values: [''] },
      { values: ['', ' \t ', 'AdventureWorks'] }, { values: ['Required database'] },
    ]);

    await run();

    const saved = (host.updates.at(-1)!.value as Array<Record<string, unknown>>)[0];
    expect(wizard.rejected).toEqual(['A database name is required.', 'A database name is required.']);
    expect(saved.name).toBe('Required database');
    expect(saved.database).toBe('AdventureWorks');
  });

  it('the database name is typed and the only connection opened is the final test with that database', async () => {
    host.stored = [valid];
    const { run } = editWith([
      { values: ['localhost,1433'] }, { pick: 'SQL Login' }, { values: ['sa'] }, { values: [''] },
      { values: [' Reporting '] }, { values: ['Typed'] },
    ]);

    await run();

    const saved = (host.updates.at(-1)!.value as Array<Record<string, unknown>>)[0];
    expect(saved.database).toBe('Reporting');
    expect(host.createQuickPick).toHaveBeenCalledTimes(1);
    expect(host.openBuiltInSession).toHaveBeenCalledTimes(1);
    expect(host.openBuiltInSession.mock.calls[0][0]).toMatchObject({ database: 'Reporting' });
  });

  it('a database that cannot be opened is reported by the final test and nothing is saved on Cancel', async () => {
    host.stored = [valid];
    const { run } = editWith([
      { values: ['localhost,1433'] }, { pick: 'SQL Login' }, { values: ['sa'] }, { values: [''] },
      { values: ['Missing'] }, { values: ['Typed'] },
    ]);
    host.openBuiltInSession.mockReset();
    host.openBuiltInSession.mockRejectedValue(Object.assign(new Error('Cannot open database "Missing" requested by the login. The login failed.'), { number: 4060 }));
    host.showErrorMessage.mockResolvedValueOnce('Cancel');

    await run();

    expect(String(host.showErrorMessage.mock.calls[0][0])).toContain('Cannot open database "Missing"');
    expect(host.showErrorMessage.mock.calls[0]).toContain('Edit');
    expect(host.updates).toHaveLength(0);
  });

  it('a long Fabric endpoint with its database saves under the suggested "server / database" display name', async () => {
    host.stored = [valid];
    const fabric = `${'x'.repeat(52)}-${'y'.repeat(26)}.datawarehouse.fabric.microsoft.com`;
    const { run } = editWith([
      { values: [fabric] }, { pick: 'SQL Login' }, { values: ['sa'] }, { values: ['pw'] },
      { values: ['Sales_Warehouse_2026'] }, { values: [`${fabric} / Sales_Warehouse_2026`] },
    ]);

    await run();

    const saved = (host.updates.at(-1)!.value as Array<Record<string, unknown>>)[0];
    expect(saved).toMatchObject({ server: fabric, database: 'Sales_Warehouse_2026', name: `${fabric} / Sales_Warehouse_2026` });
  });

  it('an over-long display name is refused at its step with the limit, not at save', async () => {
    host.stored = [valid];
    const { wizard, run } = editWith([
      { values: ['localhost,1433'] }, { pick: 'SQL Login' }, { values: ['sa'] }, { values: [''] },
      { values: ['AdventureWorks'] }, { values: ['n'.repeat(1025), 'Short'] },
    ]);

    await run();

    expect(wizard.rejected).toEqual(['A display name has at most 1024 characters.']);
    expect((host.updates.at(-1)!.value as Array<Record<string, unknown>>)[0].name).toBe('Short');
  });

  it('a self-signed certificate on the final test offers Trust Server Certificate; confirming saves the connection trusted', async () => {
    host.stored = [valid];
    const { run } = editWith([
      { values: ['localhost,1433'] }, { pick: 'SQL Login' }, { values: ['sa'] }, { values: [''] },
      { values: ['AdventureWorks'] }, { values: ['Local'] },
    ]);
    const selfSigned = Object.assign(new Error('Failed to connect to localhost:1433 - self signed certificate'), { code: 'ESOCKET' });
    host.openBuiltInSession.mockReset();
    host.openBuiltInSession.mockRejectedValueOnce(selfSigned).mockResolvedValue({ dispose: async () => {} });
    host.showErrorMessage.mockResolvedValueOnce('Trust Server Certificate');
    host.showWarningMessage.mockResolvedValueOnce('Trust Certificate');

    await run();

    expect(host.showErrorMessage.mock.calls[0]).toContain('Trust Server Certificate');
    expect(host.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('localhost'), { modal: true }, 'Trust Certificate');
    const saved = (host.updates.at(-1)!.value as Array<Record<string, unknown>>)[0];
    expect(saved.trustServerCertificate).toBe(true);
  });

  it('declining the trust confirmation saves nothing trusted', async () => {
    host.stored = [valid];
    const { run } = editWith([
      { values: ['localhost,1433'] }, { pick: 'SQL Login' }, { values: ['sa'] }, { values: [''] },
      { values: ['AdventureWorks'] }, { values: ['Local'] },
    ]);
    const selfSigned = Object.assign(new Error('Failed to connect to localhost:1433 - self signed certificate'), { code: 'ESOCKET' });
    host.openBuiltInSession.mockReset();
    host.openBuiltInSession.mockRejectedValue(selfSigned);
    host.showErrorMessage.mockResolvedValueOnce('Trust Server Certificate').mockResolvedValueOnce('Cancel');
    host.showWarningMessage.mockResolvedValueOnce(undefined);

    await run();

    expect(host.updates).toHaveLength(0);
  });

  it('edit wizard deletes the saved password when the connection switches to Entra ID', async () => {
    host.stored = [valid];
    host.getSession.mockResolvedValue({ accessToken: 't', account: { id: 'o.h', label: 'a@x' } });
    const { secrets, run } = editWith([
      { values: ['localhost,1433'] }, { pick: 'Microsoft Entra ID' }, { values: ['AdventureWorks'] }, { values: ['Entra'] },
    ]);

    await run();

    expect(secrets.delete).toHaveBeenCalledWith(passwordSecretKey(valid.id));
  });

  it('Entra sign-in saves the only directory without asking', async () => {
    host.stored = [valid];
    host.tenants = [{ tenantId: 'azure-dir', displayName: 'Default Directory' }];
    host.getSession.mockResolvedValue({ accessToken: 't', account: { id: 'o.h', label: 'a@x' } });
    const { run } = editWith([
      { values: ['localhost,1433'] }, { pick: 'Microsoft Entra ID' }, { values: ['AdventureWorks'] }, { values: ['Entra'] },
    ]);

    await run();

    expect((host.updates.at(-1)!.value as Array<Record<string, unknown>>)[0]).toMatchObject({ authenticationType: 'entraId', accountId: 'o.h', tenantId: 'azure-dir' });
  });

  it('Entra sign-in asks for the directory when the account has several, and saves the pick', async () => {
    host.stored = [valid];
    host.tenants = [{ tenantId: 'a', displayName: 'Alpha' }, { tenantId: 'b', displayName: 'Beta' }];
    host.getSession.mockResolvedValue({ accessToken: 't', account: { id: 'o.h', label: 'a@x' } });
    const { run } = editWith([
      { values: ['localhost,1433'] }, { pick: 'Microsoft Entra ID' }, { pick: 'Beta' }, { values: ['AdventureWorks'] }, { values: ['Entra'] },
    ]);

    await run();

    expect((host.updates.at(-1)!.value as Array<Record<string, unknown>>)[0]).toMatchObject({ tenantId: 'b' });
  });

  it('addDatabaseConnection deletes the saved password when the saved connection is Entra ID', async () => {
    host.stored = [valid];
    const { context, secrets } = makeContext();
    registerConnectionCommands(context, outputChannel, async () => []);

    await add({ connection: { ...valid, authenticationType: 'entraId', user: undefined }, password: 'ignored' });

    expect(secrets.delete).toHaveBeenCalledWith(key);
    expect(secrets.store).not.toHaveBeenCalled();
  });
});

describe('passwordSecretKey', () => {
  it('namespaces the secret by connection id', () => {
    expect(passwordSecretKey('abc')).toBe('dataLineageViz.database.password.abc');
  });
});

describe('saved password binding', () => {
  function memorySecrets() {
    const stored: Record<string, string> = {};
    return {
      stored,
      get: async (k: string) => stored[k],
      store: async (k: string, v: string) => { stored[k] = v; },
    };
  }
  const conn = { id: 'c1', server: 'tcp:SQL.example.com', port: 1433, user: 'sa' };

  it('returns the password for the server, port and user it was saved for', async () => {
    const secrets = memorySecrets();
    await savePassword(secrets, conn, 'pw');
    expect(secrets.stored[passwordSecretKey('c1')]).not.toBe('pw');
    await expect(readSavedPassword(secrets, { ...conn, server: 'sql.example.com' })).resolves.toBe('pw');
  });

  it.each([
    ['server', { server: 'attacker.example.com' }],
    ['port', { port: 1434 }],
    ['user', { user: 'other' }],
  ])('returns no password when the %s differs from the one it was saved for', async (_label, patch) => {
    const secrets = memorySecrets();
    await savePassword(secrets, conn, 'pw');
    await expect(readSavedPassword(secrets, { ...conn, ...patch })).resolves.toBeUndefined();
  });

  it('returns no password for an unbound or unreadable stored value', async () => {
    const secrets = memorySecrets();
    secrets.stored[passwordSecretKey('c1')] = 'plain-text';
    await expect(readSavedPassword(secrets, conn)).resolves.toBeUndefined();
    secrets.stored[passwordSecretKey('c1')] = '{"password":"pw"}';
    await expect(readSavedPassword(secrets, conn)).resolves.toBeUndefined();
  });
});
