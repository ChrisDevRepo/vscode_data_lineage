/**
 * The `Add / Edit / Remove Database Connection` and `Update Database Password` commands, and the
 * multi-step add-connection wizard behind them.
 */

import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { Logger, type LogChannel } from '../utils/log';
import { readDeclaredNumericSetting } from '../configCore';
import { openBuiltInSession, type BuiltInEnv } from '../engine/db/builtInProvider';
import { builtInTarget, CONNECTION_ERROR_LABELS, describeConnectionError, isSignInCancelled } from './connectionErrors';
import { deleteBuiltInConnection, readBuiltInConnections, upsertBuiltInConnection } from './connectionStore';
import { acquireSqlToken, defaultTenantId, listTenants, pickAccount } from './entraSignIn';
import {
  AddConnectionArgsSchema, BuiltInConnectionSchema, describeConnection, parseServerInput,
  MAX_NAME_LENGTH, MAX_SERVER_LENGTH, MAX_SYSNAME_LENGTH, passwordSecretKey, passwordTooLong,
  savePassword, tooLong, type BuiltInConnection,
} from '../engine/db/connectionSettings';
import { outcome, runSteps, wizardPrompts, type WizardStep } from './wizardSteps';

const WIZARD_TITLE = 'Add Database Connection';

const { askInput, askPick } = wizardPrompts(WIZARD_TITLE);

interface WizardState {
  server?: string;
  port?: number;
  authenticationType?: BuiltInConnection['authenticationType'];
  user?: string;
  password?: string;
  accountId?: string;
  tenantId?: string;
  database?: string;
  name?: string;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
}

function toConnection(state: WizardState, id: string): BuiltInConnection {
  return BuiltInConnectionSchema.parse({
    id,
    name: state.name || describeConnection({ server: state.server!, port: state.port, database: state.database }),
    server: state.server,
    port: state.port,
    database: state.database || undefined,
    authenticationType: state.authenticationType,
    user: state.authenticationType === 'sqlLogin' ? state.user : undefined,
    accountId: state.authenticationType === 'entraId' ? state.accountId : undefined,
    tenantId: state.tenantId,
    encrypt: state.encrypt,
    trustServerCertificate: state.trustServerCertificate,
  });
}

function hostChanged(previous: BuiltInConnection | undefined, next: Pick<BuiltInConnection, 'server' | 'port'>): boolean {
  return previous !== undefined && (previous.server !== next.server || previous.port !== next.port);
}

/**
 * Keeps the saved password consistent with its connection. A supplied password is stored for SQL
 * login; an Entra ID connection holds none, so any saved one is deleted. A saved password is also
 * deleted when an existing connection changes server, port, authentication type or user without a
 * new password, or when the previous entry is unknown (e.g. hand-edited and failing validation), so
 * it is never sent to a different host or account.
 */
async function reconcilePassword(
  secrets: BuiltInEnv['secrets'],
  previous: BuiltInConnection | undefined,
  saved: BuiltInConnection,
  password: string | undefined,
): Promise<void> {
  const key = passwordSecretKey(saved.id);
  if (saved.authenticationType !== 'sqlLogin') { await secrets.delete(key); return; }
  if (password !== undefined) { await savePassword(secrets, saved, password); return; }
  const identityChanged = hostChanged(previous, saved)
    || previous?.authenticationType !== saved.authenticationType
    || previous?.user !== saved.user;
  if (identityChanged) await secrets.delete(key);
}

function withConnectProgress<T>(title: string, task: () => Promise<T>): Thenable<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task);
}

/**
 * Runs the add (or, with `existing`, edit) wizard and saves the result. Six steps (server,
 * authentication, user, password or Microsoft sign-in, database, display name), each with a Back
 * button after the first. The database name is typed because a login that exists only inside one
 * database cannot list the server's databases; the connection is test-connected before it is
 * written, which reports a database that cannot be opened. Microsoft sign-in opens VS Code's
 * account picker and saves the account and the directory: the only one the account has, else the
 * one picked from a list starting with the {@link defaultTenantId} choice.
 *
 * @param existing - Connection to edit; its id, unrelated fields and saved password are kept. A
 *   changed server or port resets certificate trust and requires the password again; a changed user
 *   does the same for the password.
 * @param initial - Values the steps start with when adding, e.g. from a saved project.
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

  const steps: WizardStep[] = [
    {
      applies: () => true,
      run: async (step, totalSteps) => {
        const answer = await askInput({
          step, totalSteps, canGoBack: false,
          prompt: 'Server name or address — host, or host,port',
          value: state.server ? (state.port ? `${state.server},${state.port}` : state.server) : '',
          validate: (v) => tooLong(v, MAX_SERVER_LENGTH, 'server address')
            ?? (parseServerInput(v) ? undefined : 'Enter a host, or host,port with a port from 1 to 65535.'),
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
      run: async (step, totalSteps) => {
        const answer = await askPick({
          step, totalSteps, canGoBack: true, placeholder: 'Authentication',
          items: [
            { label: 'SQL Login', description: 'User name and password', value: 'sqlLogin' as const },
            { label: 'Microsoft Entra ID', description: 'Sign in with your Microsoft account, MFA supported', value: 'entraId' as const },
          ],
        });
        if (typeof answer === 'object') state.authenticationType = answer.value;
        return outcome(answer);
      },
    },
    {
      applies: () => state.authenticationType !== 'entraId',
      run: async (step, totalSteps) => {
        const answer = await askInput({
          step, totalSteps, canGoBack: true, prompt: 'SQL login user name', value: state.user ?? '',
          validate: (v) => (v.trim() ? tooLong(v, MAX_SYSNAME_LENGTH, 'user name') : 'A user name is required.'),
        });
        if (typeof answer === 'string') state.user = answer.trim();
        return outcome(answer);
      },
    },
    {
      applies: () => true,
      run: async (step, totalSteps) => {
        if (state.authenticationType === 'entraId') {
          let account: vscode.AuthenticationSessionAccountInformation;
          try {
            account = await pickAccount();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (isSignInCancelled(err)) logger.info('Account pick cancelled');
            else {
              logger.error('Pick Microsoft account', err);
              void vscode.window.showErrorMessage(message);
            }
            return 'back';
          }
          if (account.id !== state.accountId) state.tenantId = undefined;
          state.accountId = account.id;
          const tenants = await listTenants(account, logger);
          const preferred = tenants.find((t) => t.tenantId === state.tenantId)?.tenantId ?? defaultTenantId(account, tenants);
          if (tenants.length <= 1) {
            state.tenantId = tenants[0]?.tenantId ?? state.tenantId;
            return 'next';
          }
          const ordered = [...tenants].sort((a, b) => Number(b.tenantId === preferred) - Number(a.tenantId === preferred));
          const answer = await askPick({
            step, totalSteps, canGoBack: true, placeholder: `Directory of the server — signed in as ${account.label}`,
            items: ordered.map((t) => ({ label: t.displayName, description: t.defaultDomain, detail: t.tenantId, tenantId: t.tenantId })),
          });
          if (typeof answer === 'object') state.tenantId = answer.tenantId;
          return outcome(answer);
        }
        const keepSaved = existing?.authenticationType === 'sqlLogin'
          && !hostChanged(existing, state as Pick<BuiltInConnection, 'server' | 'port'>)
          && existing.user === state.user;
        const answer = await askInput({
          step, totalSteps, canGoBack: true, password: true,
          prompt: keepSaved ? 'Password — leave empty to keep the saved password' : 'Password — stored in the VS Code secret store',
          validate: (v) => passwordTooLong(v) ?? (v || keepSaved ? undefined : 'A password is required.'),
        });
        if (typeof answer === 'string') state.password = answer === '' ? undefined : answer;
        return outcome(answer);
      },
    },
    {
      applies: () => true,
      run: async (step, totalSteps) => {
        const typed = await askInput({
          step, totalSteps, canGoBack: true, value: state.database ?? '',
          prompt: 'Database name — required',
          validate: (v) => v.trim() ? tooLong(v, MAX_SYSNAME_LENGTH, 'database name') : 'A database name is required.',
        });
        if (typeof typed === 'string') state.database = typed.trim();
        return outcome(typed);
      },
    },
    {
      applies: () => true,
      run: async (step, totalSteps) => {
        const suggested = describeConnection({ server: state.server!, port: state.port, database: state.database });
        const answer = await askInput({
          step, totalSteps, canGoBack: true, prompt: 'Display name', value: existing?.name ?? suggested,
          validate: (v) => (v.trim() ? tooLong(v, MAX_NAME_LENGTH, 'display name') : 'A name is required.'),
        });
        if (typeof answer === 'string') state.name = answer.trim();
        return outcome(answer);
      },
    },
  ];

  if (!await runSteps(steps)) return undefined;
  while (true) {
    const connection = toConnection(state, id);
    const failure = await withConnectProgress(`Testing ${describeConnection(connection)}…`, async () => {
      try {
        const session = await openBuiltInSession(connection, env, testOptions());
        if (!session) return 'cancelled' as const;
        await session.dispose();
        return undefined;
      } catch (err) {
        return describeConnectionError(err, builtInTarget(connection, connection.database));
      }
    });
    if (failure === 'cancelled') return undefined;
    if (failure) {
      const offerTrust = !state.trustServerCertificate && failure.actions.some((a) => a.id === 'trustServerCertificate');
      const trustLabel = CONNECTION_ERROR_LABELS.trustServerCertificate;
      const choice = await vscode.window.showErrorMessage(failure.message, ...(offerTrust ? [trustLabel] : []), 'Edit', 'Cancel');
      if (choice === trustLabel) {
        state.trustServerCertificate = true;
        continue;
      }
      if (choice !== 'Edit') return undefined;
      if (!await runSteps(steps)) return undefined;
      continue;
    }
    await upsertBuiltInConnection(connection);
    await reconcilePassword(env.secrets, existing, connection, state.password);
    logger.info('Saved database connection');
    logger.debug(`Saved database connection ${id} (${describeConnection(connection)})`);
    return connection;
  }
}

/** Narrows the accepted connections; `refusal` says why a connection named by id is not one. */
interface ConnectionFilter {
  accepts: (connection: BuiltInConnection) => boolean;
  refusal: (connection: BuiltInConnection) => string;
}

const SQL_LOGIN_ONLY: ConnectionFilter = {
  accepts: (c) => c.authenticationType === 'sqlLogin',
  refusal: (c) => `"${c.name}" signs in with Microsoft Entra ID, which uses no password. Only SQL login connections have a saved password.`,
};

async function pickConnection(placeholder: string, filter?: ConnectionFilter): Promise<BuiltInConnection | undefined> {
  const connections = readBuiltInConnections().filter((c) => filter?.accepts(c) ?? true);
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

/** The connection an argument names by id, or the picked one; one the filter rejects warns. */
function connectionFromArg(arg: unknown, placeholder: string, filter?: ConnectionFilter): Promise<BuiltInConnection | undefined> {
  const id = typeof arg === 'string' ? arg : (arg as { id?: unknown } | undefined)?.id;
  if (typeof id !== 'string') return pickConnection(placeholder, filter);
  const named = readBuiltInConnections().find((c) => c.id === id);
  if (named && filter && !filter.accepts(named)) {
    void vscode.window.showWarningMessage(filter.refusal(named));
    return Promise.resolve(undefined);
  }
  return Promise.resolve(named);
}

/** Asks for a SQL login password once, and whether to keep it in the secret store. */
async function promptForPassword(connection: BuiltInConnection): Promise<{ password: string; save: boolean } | undefined> {
  const password = await vscode.window.showInputBox({
    title: `Password for ${connection.user} on ${connection.server}`,
    prompt: `No saved password for "${connection.name}".`,
    password: true,
    ignoreFocusOut: true,
    validateInput: passwordTooLong,
  });
  if (password === undefined) return undefined;
  const choice = await vscode.window.showQuickPick(
    [
      { label: 'Save password', description: 'Keep it in the VS Code secret store', save: true },
      { label: 'Use once', description: 'Ask again next time', save: false },
    ],
    { placeHolder: 'Save this password?', ignoreFocusOut: true },
  );
  return { password, save: choice?.save === true };
}

/** The VS Code services the built-in connection uses: secret store, settings, prompts, sign-in. */
export function createDbEnv(secrets: vscode.SecretStorage, outputChannel: LogChannel, loadQueries: BuiltInEnv['loadQueries']): BuiltInEnv {
  const queryTimeoutSeconds = () => readDeclaredNumericSetting(vscode.workspace.getConfiguration('dataLineageViz'), 'dmvQueryTimeout');
  return { secrets, outputChannel, loadQueries, queryTimeoutSeconds, promptPassword: promptForPassword, acquireSqlToken };
}

/**
 * Registers the four connection commands. `dataLineageViz.addDatabaseConnection` accepts
 * `{ connection, password? }`; with an argument it validates, saves to user settings and the secret
 * store, and returns the id without prompting. Replacing an existing id that changes
 * server, port, user or authentication type drops its saved password unless a new one is supplied.
 * `removeDatabaseConnection` removes the picked connection and its saved password and shows an
 * information toast. The other commands take an optional
 * connection id and otherwise show a picker; edit returns the saved id and update-password whether
 * a password was stored. Update-password lists and accepts only SQL login connections; an Entra ID
 * connection named by id is refused with a warning.
 */
export function registerConnectionCommands(
  context: vscode.ExtensionContext,
  outputChannel: LogChannel,
  loadQueries: BuiltInEnv['loadQueries'],
): vscode.Disposable[] {
  const env = createDbEnv(context.secrets, outputChannel, loadQueries);
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
      logger.info('Saved database connection');
      logger.debug(`Saved database connection ${connection.id} (${describeConnection(connection)})`);
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
      await deleteBuiltInConnection(target.id);
      await context.secrets.delete(passwordSecretKey(target.id));
      logger.info('Removed database connection');
      logger.debug(`Removed database connection ${target.id}`);
    }),

    vscode.commands.registerCommand('dataLineageViz.updateDatabasePassword', async (arg?: unknown): Promise<boolean> => {
      const target = await connectionFromArg(arg, 'Select a connection', SQL_LOGIN_ONLY);
      if (!target) return false;
      const password = await vscode.window.showInputBox({
        title: `New password for ${target.name}`,
        prompt: 'Stored in the VS Code secret store, never in settings.',
        password: true,
        ignoreFocusOut: true,
        validateInput: passwordTooLong,
      });
      if (password === undefined) return false;
      await savePassword(context.secrets, target, password);
      logger.info('Updated saved database password');
      logger.debug(`Updated saved password for database connection ${target.id}`);
      return true;
    }),
  ];
}
