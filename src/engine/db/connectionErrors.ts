/**
 * One place that turns a failed connect or query into the text and actions the user sees. The
 * driver's own message is shown verbatim behind the connection name, except when the server reports
 * that it is unavailable (one plain sentence, the driver text goes to the log); only the actions are
 * chosen, by error number, code or message pattern.
 */

import * as vscode from 'vscode';
import type { Logger } from '../../utils/log';
import type { StoredConnectionInfo } from '../shared/bridgeContract';
import { readBuiltInConnections, upsertBuiltInConnection, describeConnection, resolveServerAddress, AZURE_SQL_HOST, type BuiltInConnection } from './connectionSettings';
import { DbConnectionError, MicrosoftSignInError, type ConnectionErrorTarget, type DbSession } from './dbSession';
import { pickAccount, signInForSql } from './entraSignIn';
import { redactSecrets } from '../../utils/redact';
import { errorMessage } from '../../utils/errorMessage';
import { quoteIdentifier } from '../../utils/sql';

/** Identifier of an action a connection error can offer. */
export type ConnectionErrorActionId =
  | 'updatePassword' | 'editConnection' | 'signInAnotherAccount' | 'chooseDatabase' | 'retry'
  | 'trustServerCertificate' | 'signIn' | 'copyGrantStatement' | 'showLog';

/** A button offered next to a connection error. */
export interface ConnectionErrorAction {
  id: ConnectionErrorActionId;
  label: string;
  /** Performs the action once, on the user's click. */
  run(): Promise<void>;
}

/** What the caller can do on the user's behalf when an action asks for it. */
export interface ConnectionErrorHooks {
  /** Repeats the failed operation once; `patch` overrides stored connection fields for it. */
  retry?: (patch?: Partial<StoredConnectionInfo>) => Promise<void> | void;
  chooseDatabase?: () => Promise<string | undefined>;
  showLog?: () => void;
  /** The permission clause the failed operation needs; `VIEW DEFINITION` when absent. */
  grant?: string;
}

/** Button labels, one per action id. */
export const CONNECTION_ERROR_LABELS: Readonly<Record<ConnectionErrorActionId, string>> = {
  updatePassword: 'Update Password',
  editConnection: 'Edit Connection',
  signInAnotherAccount: 'Sign in with another account',
  chooseDatabase: 'Choose Database',
  retry: 'Retry',
  trustServerCertificate: 'Trust Server Certificate',
  signIn: 'Sign In',
  copyGrantStatement: 'Copy GRANT Statement',
  showLog: 'Show Log',
};

type ErrorKind =
  | 'tokenRejected' | 'loginFailed' | 'cannotOpenDatabase' | 'unavailable' | 'certificate' | 'network'
  | 'signInCancelled' | 'permission' | 'other';

const UNAVAILABLE_NUMBERS: ReadonlySet<number> = new Set([40613, 40197, 40501, 40532, 10928, 10929]);
/** Codes of a connect that timed out or dropped, as a server that is still starting also causes. */
const STARTING_CODES: ReadonlySet<string> = new Set(['ETIMEOUT', 'ESOCKET']);
const PERMISSION_NUMBERS: ReadonlySet<number> = new Set([229, 297, 300]);
const NETWORK_CODES: ReadonlySet<string> = new Set(['ETIMEOUT', 'ESOCKET', 'ENOTFOUND', 'ECONNREFUSED']);

const CERTIFICATE_TEXT = /self[- ]signed certificate|unable to verify the first certificate|unable to get local issuer certificate|certificate chain|certificate (?:is not trusted|has expired)|CERT_[A-Z_]+/i;
const NETWORK_TEXT = /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|Failed to connect to .+ in \d+ms/i;
const UNAVAILABLE_TEXT = /is not currently available|service is currently busy|encountered an error processing your request|requested by the login\.\s+The login failed/i;
const PERMISSION_TEXT = /permission was denied|permission denied|does not have permission to perform this action/i;
const TOKEN_REJECTED_TEXT = /not currently configured to accept this token/i;
const TOKEN_REJECTED_HINT = 'The server did not accept this Microsoft account. Check that the server has a Microsoft Entra admin and that the account is a user in the database, or sign in with another account.';
const SIGN_IN_TEXT = /Microsoft sign-in did not complete|User did not consent to login/i;
const CANNOT_OPEN_DATABASE_TEXT = /Cannot open database\s+["'].+["']\s+requested by the login|not able to access the database/i;

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

function errorNumber(err: unknown): number | undefined {
  const holder = err as { number?: unknown; info?: { number?: unknown } } | undefined;
  const value = holder?.number ?? holder?.info?.number;
  return typeof value === 'number' ? value : undefined;
}

/**
 * Whether an error came from the SQL driver rather than this extension's own logic: driver errors
 * carry a numeric SQL Server error number or an `E…` code (`ELOGIN`, `ETIMEOUT`, `ESOCKET`,
 * `EREQUEST`).
 * @internal
 */
export function isDriverError(err: unknown): boolean {
  return errorNumber(err) !== undefined || /^E[A-Z]+$/.test(errorCode(err) ?? '');
}

/**
 * Whether the error is the user cancelling a Microsoft sign-in (including declining consent), not a
 * failure.
 */
export function isSignInCancelled(err: unknown): boolean {
  return classify(err) === 'signInCancelled';
}

function classify(err: unknown): ErrorKind {
  const text = errorMessage(err);
  const number = errorNumber(err);
  const code = errorCode(err);
  if (err instanceof MicrosoftSignInError || SIGN_IN_TEXT.test(text)) return 'signInCancelled';
  if (TOKEN_REJECTED_TEXT.test(text)) return 'tokenRejected';
  if (number === 18456 || /Login failed for user/i.test(text)) return 'loginFailed';
  if (number === 4060 || number === 916 || CANNOT_OPEN_DATABASE_TEXT.test(text)) return 'cannotOpenDatabase';
  if ((number !== undefined && UNAVAILABLE_NUMBERS.has(number)) || UNAVAILABLE_TEXT.test(text)) return 'unavailable';
  if (CERTIFICATE_TEXT.test(text)) return 'certificate';
  if ((number !== undefined && PERMISSION_NUMBERS.has(number)) || PERMISSION_TEXT.test(text)) return 'permission';
  if ((code !== undefined && NETWORK_CODES.has(code)) || NETWORK_TEXT.test(text)) return 'network';
  return 'other';
}

function grantStatement(grant: string, user: string | undefined): string {
  const principal = user ? quoteIdentifier(user) : '[user_or_group]';
  return `GRANT ${grant} TO ${principal};`;
}

/**
 * Describes a connection or query failure for the user. `message` is
 * `<connection name>: <original driver text>` with credential-shaped text removed, plus one hint
 * when the server rejects a Microsoft token, or "It might still be starting." when a connect to an
 * Azure SQL host timed out or dropped; for an unavailable server it is "Couldn't connect to
 * <database>. It might still be starting." Actions depend on the error class: those updating a
 * connection are offered for a `builtIn` connection, and Retry is offered only when the caller
 * supplies a retry hook. Each action runs on the user's click and any retry is a single
 * attempt, never a loop.
 *
 * @param hooks - Caller-supplied capabilities the actions use.
 */
export function describeConnectionError(
  err: unknown,
  target: ConnectionErrorTarget,
  hooks: ConnectionErrorHooks = {},
): { message: string; actions: ConnectionErrorAction[] } {
  const kind = classify(err);
  const stillStarting = kind === 'network' && STARTING_CODES.has(errorCode(err) ?? '') && AZURE_SQL_HOST.test(resolveServerAddress(target.server).host);
  const hint = kind === 'tokenRejected' ? ` ${TOKEN_REJECTED_HINT}` : stillStarting ? ' It might still be starting.' : '';
  const message = kind === 'unavailable'
    ? `Couldn't connect to ${target.database ?? target.name}. It might still be starting.`
    : `${target.name}: ${redactSecrets(errorMessage(err))}${hint}`;
  const builtIn = target.provider === 'builtIn';
  const connectionId = target.connectionId;

  const make = (id: ConnectionErrorActionId, run: () => Promise<void>): ConnectionErrorAction => ({
    id, label: CONNECTION_ERROR_LABELS[id], run,
  });
  const retry = async (patch?: Partial<StoredConnectionInfo>) => { await hooks.retry?.(patch); };

  const actions = {
    updatePassword: () => make('updatePassword', async () => {
      const stored = await vscode.commands.executeCommand<boolean | undefined>('dataLineageViz.updateDatabasePassword', connectionId);
      if (stored) await retry();
    }),
    editConnection: () => make('editConnection', async () => {
      const saved = await vscode.commands.executeCommand<string | undefined>('dataLineageViz.editDatabaseConnection', connectionId);
      if (saved) await retry();
    }),
    signInAnotherAccount: () => make('signInAnotherAccount', async () => {
      const account = await pickAccount();
      const saved = readBuiltInConnections().find((c) => c.id === connectionId);
      if (saved) await upsertBuiltInConnection({ ...saved, accountId: account.id, tenantId: undefined });
      await retry();
    }),
    signIn: () => make('signIn', async () => {
      await signInForSql(target.tenantId, { createIfNone: true });
      await retry();
    }),
    chooseDatabase: () => make('chooseDatabase', async () => {
      const database = await hooks.chooseDatabase?.();
      if (!database) return;
      const saved = readBuiltInConnections().find((c) => c.id === connectionId);
      if (saved) await upsertBuiltInConnection({ ...saved, database });
      await retry({ database });
    }),
    trustServerCertificate: () => make('trustServerCertificate', async () => {
      const saved = readBuiltInConnections().find((c) => c.id === connectionId);
      if (!saved) return;
      await upsertBuiltInConnection({ ...saved, trustServerCertificate: true });
      await retry({ trustServerCertificate: true });
    }),
    retry: () => make('retry', () => retry()),
    copyGrantStatement: () => make('copyGrantStatement', async () => {
      await vscode.env.clipboard.writeText(grantStatement(hooks.grant ?? 'VIEW DEFINITION', target.user));
      vscode.window.setStatusBarMessage('GRANT statement copied to the clipboard.', 5000);
    }),
    showLog: () => make('showLog', async () => {
      if (hooks.showLog) hooks.showLog();
      else await vscode.commands.executeCommand('workbench.action.output.toggleOutput');
    }),
  };

  const entra = target.authenticationType === 'entraId' || /token-identified principal/i.test(errorMessage(err));
  const wanted: ConnectionErrorAction[] = [];
  const add = (...items: Array<ConnectionErrorAction | undefined>) => wanted.push(...items.filter((a): a is ConnectionErrorAction => !!a));
  const managed = (factory: () => ConnectionErrorAction) => (builtIn ? factory() : undefined);
  const retrying = () => (hooks.retry ? actions.retry() : undefined);

  switch (kind) {
    case 'tokenRejected':
      add(managed(actions.signInAnotherAccount), managed(actions.editConnection));
      break;
    case 'loginFailed':
      if (entra) add(managed(actions.signInAnotherAccount), managed(actions.editConnection));
      else add(managed(actions.updatePassword), target.database && hooks.chooseDatabase ? managed(actions.chooseDatabase) : undefined, managed(actions.editConnection));
      break;
    case 'cannotOpenDatabase':
      add(hooks.chooseDatabase ? managed(actions.chooseDatabase) : undefined, managed(actions.editConnection));
      break;
    case 'unavailable':
      add(retrying());
      break;
    case 'network':
      add(managed(actions.editConnection), retrying());
      break;
    case 'certificate':
      add(managed(actions.trustServerCertificate), managed(actions.editConnection));
      break;
    case 'signInCancelled':
      add(managed(actions.signIn), managed(actions.signInAnotherAccount));
      break;
    case 'permission':
      add(actions.copyGrantStatement());
      break;
    default:
      add(actions.showLog(), managed(actions.editConnection));
  }
  return { message, actions: wanted };
}

/**
 * Logs a connection error once, shows it with its actions, and runs the action the user picks.
 * Redacted driver detail goes to the log at debug level; the toast carries the described message,
 * never the raw error alone. The returned `message` is for callers that also show the text inline,
 * with a promise that settles once the toast is answered or dismissed.
 */
export function reportConnectionError(
  err: unknown,
  target: ConnectionErrorTarget,
  logger: Pick<Logger, 'error' | 'debug'>,
  hooks: ConnectionErrorHooks = {},
  present: (message: string, ...labels: string[]) => Thenable<string | undefined> = vscode.window.showErrorMessage,
): { message: string; actions: ConnectionErrorAction[]; answered: Promise<void> } {
  const { message, actions } = describeConnectionError(err, target, hooks);
  logger.error('Database connection failed', `code=${errorCode(err) ?? '-'} number=${errorNumber(err) ?? '-'}`);
  logger.debug(`Connection error on ${target.name} — code=${errorCode(err) ?? '-'} number=${errorNumber(err) ?? '-'} raw="${redactSecrets(errorMessage(err))}"`);
  const answered = (async () => {
    const choice = await present(message, ...actions.map((a) => a.label));
    const chosen = actions.find((a) => a.label === choice);
    if (!chosen) return;
    try {
      await chosen.run();
    } catch (actionErr) {
      logger.error('Connection action failed', chosen.id);
      logger.debug(`Connection action error: ${redactSecrets(errorMessage(actionErr))}`);
    }
  })();
  return { message, actions, answered };
}

/** The error target of a saved built-in connection opened on `database`. */
export function builtInTarget(connection: BuiltInConnection, database: string | undefined): ConnectionErrorTarget {
  return {
    provider: 'builtIn',
    name: connection.name,
    server: connection.server,
    port: connection.port,
    database,
    user: connection.user,
    authenticationType: connection.authenticationType,
    connectionId: connection.id,
    tenantId: connection.tenantId,
  };
}

/**
 * The error and target to report for a failed connect, or for a driver error on the open `session`;
 * `undefined` for any other error.
 */
export function connectionFailure(err: unknown, session?: DbSession): { error: unknown; target: ConnectionErrorTarget } | undefined {
  if (err instanceof DbConnectionError) return { error: err.original, target: err.target };
  return session && isDriverError(err) ? { error: err, target: targetFromStored(session.connectionInfo, session.provider) } : undefined;
}

/** Builds the error target for a stored connection record and the provider that is connecting. @internal */
export function targetFromStored(info: StoredConnectionInfo, provider: ConnectionErrorTarget['provider']): ConnectionErrorTarget {
  const saved = provider === 'builtIn' && info.connectionId
    ? readBuiltInConnections().find((c) => c.id === info.connectionId)
    : undefined;
  return {
    provider,
    name: saved?.name ?? describeConnection({ server: info.server, port: info.port, database: info.database || undefined }),
    server: info.server,
    port: info.port,
    database: info.database || undefined,
    user: info.user,
    authenticationType: info.authenticationType,
    connectionId: info.connectionId,
    tenantId: info.tenantId,
  };
}
