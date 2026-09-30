/**
 * @module ConnectionCommands
 * The `Add / Edit / Remove Database Connection` and `Update Database Password` commands, and the
 * multi-step add-connection wizard behind them.
 */

import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { Logger } from '../../utils/log';
import { notifyInfo } from '../../utils/notifications';
import { openBuiltInSession, listAccessibleDatabases, type BuiltInEnv } from './builtInProvider';
import { CONNECTION_ERROR_LABELS, confirmTrustServerCertificate, describeConnectionError } from './connectionErrors';
import {
  AddConnectionArgsSchema, BuiltInConnectionSchema, deleteBuiltInConnection, describeConnection, dropTcpPrefix,
  passwordSecretKey, passwordTooLong, readBuiltInConnections, upsertBuiltInConnection, type BuiltInConnection,
} from './connectionSettings';

const WIZARD_TITLE = 'Add Database Connection';
const WIZARD_STEPS = 6;
const MAX_TCP_PORT = 65535;

/**
 * Parses the wizard's server field: `host` or `host,port`, with an optional `tcp:` prefix dropped.
 *
 * @returns The host and optional port, or `undefined` when the text is not a valid server.
 */
export function parseServerInput(text: string): { server: string; port?: number } | undefined {
  const [typed, port, ...rest] = text.split(',').map((part) => part.trim());
  const host = dropTcpPrefix(typed ?? '');
  if (!host || rest.length > 0) return undefined;
  if (port === undefined) return { server: host };
  if (!/^\d+$/.test(port)) return undefined;
  const value = Number(port);
  return value >= 1 && value <= MAX_TCP_PORT ? { server: host, port: value } : undefined;
}

const BACK = Symbol('back');
type Answer<T> = T | typeof BACK | undefined;

interface InputOptions {
  step: number;
  prompt: string;
  value?: string;
  placeholder?: string;
  password?: boolean;
  canGoBack: boolean;
  validate?: (value: string) => string | undefined;
}

function askInput(options: InputOptions): Promise<Answer<string>> {
  return new Promise((resolve) => {
    const box = vscode.window.createInputBox();
    box.title = WIZARD_TITLE;
    box.step = options.step;
    box.totalSteps = WIZARD_STEPS;
    box.prompt = options.prompt;
    box.value = options.value ?? '';
    box.placeholder = options.placeholder;
    box.password = options.password === true;
    box.ignoreFocusOut = true;
    box.buttons = options.canGoBack ? [vscode.QuickInputButtons.Back] : [];
    const done = (answer: Answer<string>) => { resolve(answer); box.dispose(); };
    box.onDidTriggerButton((button) => { if (button === vscode.QuickInputButtons.Back) done(BACK); });
    box.onDidAccept(() => {
      const problem = options.validate?.(box.value);
      if (problem) { box.validationMessage = problem; return; }
      done(box.value);
    });
    box.onDidHide(() => done(undefined));
    box.show();
  });
}

interface PickOptions<T extends vscode.QuickPickItem> {
  step: number;
  placeholder: string;
  items: T[];
  canGoBack: boolean;
  /** Offers the typed text as an extra item after the list, for values that may not be in it; a listed match stays active. */
  custom?: (typed: string) => T;
}

function askPick<T extends vscode.QuickPickItem>(options: PickOptions<T>): Promise<Answer<T>> {
  return new Promise((resolve) => {
    const pick = vscode.window.createQuickPick<T>();
    pick.title = WIZARD_TITLE;
    pick.step = options.step;
    pick.totalSteps = WIZARD_STEPS;
    pick.placeholder = options.placeholder;
    pick.ignoreFocusOut = true;
    pick.matchOnDescription = true;
    pick.items = options.items;
    pick.buttons = options.canGoBack ? [vscode.QuickInputButtons.Back] : [];
    const done = (answer: Answer<T>) => { resolve(answer); pick.dispose(); };
    pick.onDidTriggerButton((button) => { if (button === vscode.QuickInputButtons.Back) done(BACK); });
    if (options.custom) {
      pick.onDidChangeValue((typed) => {
        const trimmed = typed.trim().toLowerCase();
        const exact = options.items.some((i) => i.label.toLowerCase() === trimmed);
        pick.items = trimmed && !exact ? [...options.items, options.custom!(typed.trim())] : options.items;
        const listed = trimmed ? options.items.find((i) => i.label.toLowerCase().includes(trimmed)) : undefined;
        if (listed) pick.activeItems = [listed];
      });
    }
    pick.onDidAccept(() => done(pick.selectedItems[0]));
    pick.onDidHide(() => done(undefined));
    pick.show();
  });
}

/** Database-step item that saves the connection without a database, as the mssql extension's optional database. */
const CHOOSE_WHEN_CONNECTING = 'Choose when connecting';

interface WizardState {
  server?: string;
  port?: number;
  authenticationType?: BuiltInConnection['authenticationType'];
  user?: string;
  password?: string;
  tenantId?: string;
  database?: string;
  name?: string;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
}

type StepOutcome = 'next' | 'back' | 'cancel';

const outcome = (answer: Answer<unknown>): StepOutcome => (answer === BACK ? 'back' : answer === undefined ? 'cancel' : 'next');

function toConnection(state: WizardState, id: string): BuiltInConnection {
  return BuiltInConnectionSchema.parse({
    id,
    name: state.name || describeConnection({ server: state.server!, port: state.port, database: state.database }),
    server: state.server,
    port: state.port,
    database: state.database || undefined,
    authenticationType: state.authenticationType,
    user: state.authenticationType === 'sqlLogin' ? state.user : undefined,
    tenantId: state.tenantId,
    encrypt: state.encrypt,
    trustServerCertificate: state.trustServerCertificate,
  });
}

function hostChanged(previous: BuiltInConnection | undefined, next: Pick<BuiltInConnection, 'server' | 'port'>): boolean {
  return previous !== undefined && (previous.server !== next.server || previous.port !== next.port);
}

/**
 * Keeps the saved password consistent with the connection it belongs to.
 *
 * @remarks
 * A supplied password is stored for SQL login. An Entra ID connection holds no password, so any
 * saved one is deleted. A saved password is also deleted when an existing connection changes
 * server, port, authentication type or user without a new password, so it is never sent to a
 * different host or account.
 */
async function reconcilePassword(
  secrets: vscode.SecretStorage,
  previous: BuiltInConnection | undefined,
  saved: BuiltInConnection,
  password: string | undefined,
): Promise<void> {
  const key = passwordSecretKey(saved.id);
  if (saved.authenticationType !== 'sqlLogin') { await secrets.delete(key); return; }
  if (password !== undefined) { await secrets.store(key, password); return; }
  const identityChanged = hostChanged(previous, saved)
    || previous?.authenticationType !== saved.authenticationType
    || previous?.user !== saved.user;
  if (previous && identityChanged) await secrets.delete(key);
}

function withConnectProgress<T>(title: string, task: () => Promise<T>): Thenable<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task);
}

/**
 * Runs the add (or, with `existing`, edit) wizard and saves the result.
 *
 * @remarks
 * Six steps — server, authentication, user, password or Microsoft sign-in, optional database, display name —
 * each with a Back button after the first. The database list comes from a test connection made
 * before the database is chosen; when the list cannot be read the step falls back to free text. The
 * saved connection is test-connected once more before it is written.
 *
 * @param env - Host services.
 * @param existing - Connection to edit; its id, unrelated fields and saved password are kept. A
 *   changed server or port resets certificate trust and requires the password to be entered again;
 *   a changed user does the same for the password.
 * @param initial - Values the steps start with when adding, for example from a saved project.
 * @returns The saved connection, or `undefined` when the user cancelled.
 */
export async function runAddConnectionFlow(
  env: BuiltInEnv,
  existing?: BuiltInConnection,
  initial?: Pick<WizardState, 'server' | 'port' | 'user' | 'database'>,
): Promise<BuiltInConnection | undefined> {
  const logger = Logger.create(env.outputChannel, 'DB');
  const id = existing?.id ?? randomUUID();
  const state: WizardState = existing
    ? { ...existing }
    : { ...initial };

  const testOptions = () => (state.password !== undefined ? { password: state.password } : {});
  const draft = () => toConnection({ ...state, name: state.name ?? 'draft' }, id);

  const steps: Array<{ applies: () => boolean; run: (n: number) => Promise<StepOutcome> }> = [
    {
      applies: () => true,
      run: async (n) => {
        const answer = await askInput({
          step: n, canGoBack: false,
          prompt: 'Server name or address — host, or host,port',
          value: state.server ? (state.port ? `${state.server},${state.port}` : state.server) : '',
          validate: (v) => (parseServerInput(v) ? undefined : 'Enter a host, or host,port with a port from 1 to 65535.'),
        });
        if (typeof answer === 'string') {
          Object.assign(state, { port: undefined }, parseServerInput(answer));
          state.trustServerCertificate = hostChanged(existing, state as Pick<BuiltInConnection, 'server' | 'port'>)
            ? false
            : existing?.trustServerCertificate;
        }
        return outcome(answer);
      },
    },
    {
      applies: () => true,
      run: async (n) => {
        const answer = await askPick({
          step: n, canGoBack: true, placeholder: 'Authentication',
          items: [
            { label: 'SQL Login', description: 'User name and password', value: 'sqlLogin' as const },
            { label: 'Microsoft Entra ID', description: 'Sign in with a Microsoft account', value: 'entraId' as const },
          ],
        });
        if (typeof answer === 'object') state.authenticationType = answer.value;
        return outcome(answer);
      },
    },
    {
      applies: () => state.authenticationType === 'sqlLogin',
      run: async (n) => {
        const answer = await askInput({
          step: n, canGoBack: true, prompt: 'SQL login user name', value: state.user ?? '',
          validate: (v) => (v.trim() ? undefined : 'A user name is required.'),
        });
        if (typeof answer === 'string') state.user = answer.trim();
        return outcome(answer);
      },
    },
    {
      applies: () => true,
      run: async (n) => {
        if (state.authenticationType === 'entraId') {
          try {
            await vscode.authentication.getSession('microsoft', ['https://database.windows.net//.default'], { createIfNone: true });
            return 'next';
          } catch (err) {
            void vscode.window.showErrorMessage(`Microsoft sign-in did not complete: ${err instanceof Error ? err.message : String(err)}`);
            return 'back';
          }
        }
        const keepSaved = existing?.authenticationType === 'sqlLogin'
          && !hostChanged(existing, state as Pick<BuiltInConnection, 'server' | 'port'>)
          && existing.user === state.user;
        const answer = await askInput({
          step: n, canGoBack: true, password: true,
          prompt: keepSaved ? 'Password — leave empty to keep the saved password' : 'Password — stored in the VS Code secret store',
          validate: (v) => passwordTooLong(v) ?? (v || keepSaved ? undefined : 'A password is required.'),
        });
        if (typeof answer === 'string') state.password = answer === '' ? undefined : answer;
        return outcome(answer);
      },
    },
    {
      applies: () => true,
      run: async (n) => {
        let databases: string[] | undefined;
        try {
          const probe = { ...draft(), database: undefined };
          databases = await withConnectProgress(`Connecting to ${describeConnection(probe)}…`, async () => {
            const session = await openBuiltInSession(probe, env, testOptions());
            if (!session) return undefined;
            try { return await listAccessibleDatabases(session, env); } finally { await session.dispose(); }
          });
        } catch (err) {
          logger.debug(`Database list unavailable for ${state.server}: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (!databases || databases.length === 0) {
          const typed = await askInput({
            step: n, canGoBack: true, value: state.database ?? '',
            prompt: 'Database name (optional) — leave empty to choose when connecting',
          });
          if (typeof typed === 'string') state.database = typed.trim() || undefined;
          return outcome(typed);
        }
        const answer = await askPick({
          step: n, canGoBack: true, placeholder: 'Database (optional)',
          items: [
            { label: CHOOSE_WHEN_CONNECTING, description: 'Ask for the database when a new project starts', picked: !state.database },
            ...databases.map((label): vscode.QuickPickItem => ({ label, picked: label === state.database })),
          ],
          custom: (label) => ({ label, description: 'Use this name' }),
        });
        if (typeof answer === 'object') state.database = answer.label === CHOOSE_WHEN_CONNECTING ? undefined : answer.label;
        return outcome(answer);
      },
    },
    {
      applies: () => true,
      run: async (n) => {
        const suggested = describeConnection({ server: state.server!, port: state.port, database: state.database });
        const answer = await askInput({
          step: n, canGoBack: true, prompt: 'Display name', value: existing?.name ?? suggested,
          validate: (v) => (v.trim() ? undefined : 'A name is required.'),
        });
        if (typeof answer === 'string') state.name = answer.trim();
        return outcome(answer);
      },
    },
  ];

  let at = 0;
  let direction = 1;
  while (true) {
    if (at >= steps.length) {
      const connection = toConnection(state, id);
      const failure = await withConnectProgress(`Testing ${describeConnection(connection)}…`, async () => {
        try {
          const session = await openBuiltInSession(connection, env, testOptions());
          if (!session) return 'cancelled' as const;
          await session.dispose();
          return undefined;
        } catch (err) {
          return describeConnectionError(err, {
            provider: 'builtIn', name: connection.name, server: connection.server, port: connection.port,
            database: connection.database, user: connection.user, authenticationType: connection.authenticationType,
            connectionId: connection.id, tenantId: connection.tenantId,
          });
        }
      });
      if (failure === 'cancelled') return undefined;
      if (failure) {
        const offerTrust = !state.trustServerCertificate && failure.actions.some((a) => a.id === 'trustServerCertificate');
        const trustLabel = CONNECTION_ERROR_LABELS.trustServerCertificate;
        const choice = await vscode.window.showErrorMessage(failure.message, ...(offerTrust ? [trustLabel] : []), 'Edit', 'Cancel');
        if (choice === trustLabel) {
          if (await confirmTrustServerCertificate(connection)) state.trustServerCertificate = true;
          continue;
        }
        if (choice !== 'Edit') return undefined;
        at = 0;
        direction = 1;
        continue;
      }
      await upsertBuiltInConnection(connection);
      await reconcilePassword(env.secrets, existing, connection, state.password);
      notifyInfo(logger, 'Save database connection', `Saved connection "${connection.name}".`, { connectionId: id });
      return connection;
    }
    if (at < 0) return undefined;
    const step = steps[at];
    if (!step.applies()) { at += direction; continue; }
    const result = await step.run(at + 1);
    if (result === 'cancel') return undefined;
    direction = result === 'back' ? -1 : 1;
    at += direction;
  }
}

async function pickConnection(placeholder: string, filter?: (c: BuiltInConnection) => boolean): Promise<BuiltInConnection | undefined> {
  const connections = readBuiltInConnections().filter(filter ?? (() => true));
  if (connections.length === 0) {
    void vscode.window.showInformationMessage('No matching built-in database connections. Use "Data Lineage: Add Database Connection" first.');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    connections.map((connection) => ({
      label: connection.name,
      description: describeConnection(connection),
      detail: connection.authenticationType === 'entraId' ? 'Microsoft Entra ID' : `SQL Login (${connection.user ?? 'no user'})`,
      connection,
    })),
    { placeHolder: placeholder, ignoreFocusOut: true, matchOnDescription: true },
  );
  return picked?.connection;
}

function connectionFromArg(arg: unknown, placeholder: string, filter?: (c: BuiltInConnection) => boolean): Promise<BuiltInConnection | undefined> {
  const id = typeof arg === 'string' ? arg : (arg as { id?: unknown } | undefined)?.id;
  if (typeof id === 'string') return Promise.resolve(readBuiltInConnections().find((c) => c.id === id));
  return pickConnection(placeholder, filter);
}

/**
 * Registers the four connection commands.
 *
 * @remarks
 * `dataLineageViz.addDatabaseConnection` accepts `{ connection, password? }`; with an argument it
 * validates, saves to user settings and the secret store without prompting, and returns the id;
 * replacing an existing id that changes server, port, user or authentication type drops its saved
 * password unless a new one is supplied. `removeDatabaseConnection` always asks for confirmation.
 * The other commands take an optional connection id and otherwise show a picker; edit returns the
 * saved id and update-password returns whether a password was stored.
 */
export function registerConnectionCommands(
  context: vscode.ExtensionContext,
  outputChannel: vscode.LogOutputChannel,
  loadQueries: BuiltInEnv['loadQueries'],
): vscode.Disposable[] {
  const env: BuiltInEnv = { secrets: context.secrets, outputChannel, loadQueries };
  const logger = Logger.create(outputChannel, 'DB');

  return [
    vscode.commands.registerCommand('dataLineageViz.addDatabaseConnection', async (arg?: unknown): Promise<string | undefined> => {
      if (arg === undefined) return (await runAddConnectionFlow(env))?.id;
      const parsed = AddConnectionArgsSchema.safeParse(arg);
      if (!parsed.success) {
        const problems = parsed.error.issues.map((i) => `${i.path.join('.') || 'argument'}: ${i.message}`).join('; ');
        throw new Error(`Invalid database connection: ${problems}`);
      }
      const connection = BuiltInConnectionSchema.parse({ ...parsed.data.connection, id: parsed.data.connection.id ?? randomUUID() });
      const previous = readBuiltInConnections(logger).find((c) => c.id === connection.id);
      await upsertBuiltInConnection(connection);
      await reconcilePassword(context.secrets, previous, connection, parsed.data.password);
      logger.info(`Saved database connection ${connection.id} (${describeConnection(connection)})`);
      return connection.id;
    }),

    vscode.commands.registerCommand('dataLineageViz.editDatabaseConnection', async (arg?: unknown): Promise<string | undefined> => {
      const existing = await connectionFromArg(arg, 'Select a connection to edit');
      if (!existing) return undefined;
      return (await runAddConnectionFlow(env, existing))?.id;
    }),

    vscode.commands.registerCommand('dataLineageViz.removeDatabaseConnection', async (arg?: unknown): Promise<void> => {
      const target = await connectionFromArg(arg, 'Select a connection to remove');
      if (!target) return;
      const choice = await vscode.window.showWarningMessage(
        `Remove "${target.name}"? Its saved password is deleted too.`, { modal: true }, 'Remove',
      );
      if (choice !== 'Remove') return;
      await deleteBuiltInConnection(target.id);
      await context.secrets.delete(passwordSecretKey(target.id));
      logger.info(`Removed database connection ${target.id}`);
    }),

    vscode.commands.registerCommand('dataLineageViz.updateDatabasePassword', async (arg?: unknown): Promise<boolean> => {
      const target = await connectionFromArg(arg, 'Select a connection', (c) => c.authenticationType === 'sqlLogin');
      if (!target) return false;
      const password = await vscode.window.showInputBox({
        title: `New password for ${target.name}`,
        prompt: 'Stored in the VS Code secret store, never in settings.',
        password: true,
        ignoreFocusOut: true,
        validateInput: passwordTooLong,
      });
      if (password === undefined) return false;
      await context.secrets.store(passwordSecretKey(target.id), password);
      logger.info(`Updated saved password for database connection ${target.id}`);
      return true;
    }),
  ];
}
