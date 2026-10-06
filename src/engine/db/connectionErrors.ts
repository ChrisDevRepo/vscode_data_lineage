/**
 * @module ConnectionErrors
 * One place that turns a failed connect or query into the text and actions the user sees.
 *
 * The driver's own message is shown verbatim behind the connection name; only the actions are chosen
 * by error number, code or message pattern. Both providers use it.
 */

import * as vscode from 'vscode';
import type { Logger } from '../../utils/log';
import type { StoredConnectionInfo } from '../shared/bridgeContract';
import { readBuiltInConnections, upsertBuiltInConnection, describeConnection, type BuiltInConnection } from './connectionSettings';
import { DbConnectionError, MicrosoftSignInError, type ConnectionErrorTarget, type DbSession } from './dbSession';
import { pickAccount, signInForSql } from './entraSignIn';
import { redactSecrets } from '../../utils/redact';

/** Identifier of an action a connection error can offer. */
export type ConnectionErrorActionId =
  | 'updatePassword' | 'editConnection' | 'signInAnotherAccount' | 'chooseDatabase' | 'retry'
  | 'trustServerCertificate' | 'signIn' | 'copyGrantStatement' | 'showLog';

/** A button offered next to a connection error. */
export interface ConnectionErrorAction {
  /** Stable identifier. */
  id: ConnectionErrorActionId;
  /** Button text. */
  label: string;
  /** Performs the action once, on the user's click. */
  run(): Promise<void>;
}

/** What the caller can do on the user's behalf when an action asks for it. */
export interface ConnectionErrorHooks {
  /** Repeats the failed operation once; `patch` overrides stored connection fields for that attempt. */
  retry?: (patch?: Partial<StoredConnectionInfo>) => Promise<void> | void;
  /** Asks the user for a database name. */
  chooseDatabase?: () => Promise<string | undefined>;
  /** Reveals the extension's log. */
  showLog?: () => void;
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

const UNAVAILABLE_NUMBERS: ReadonlySet<number> = new Set([40613, 40197, 40501, 40532]);
const PERMISSION_NUMBERS: ReadonlySet<number> = new Set([229, 297, 300]);
const NETWORK_CODES: ReadonlySet<string> = new Set(['ETIMEOUT', 'ESOCKET', 'ENOTFOUND', 'ECONNREFUSED']);

const TRUST_CERTIFICATE = 'Trust Certificate';
const CERTIFICATE_TEXT = /self[- ]signed certificate|unable to verify the first certificate|unable to get local issuer certificate|certificate chain|certificate (?:is not trusted|has expired)|CERT_[A-Z_]+/i;
const NETWORK_TEXT = /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|Failed to connect to .+ in \d+ms/i;
const UNAVAILABLE_TEXT = /is not currently available|service is currently busy|encountered an error processing your request|requested by the login\.\s+The login failed/i;
const PERMISSION_TEXT = /permission was denied|permission denied|does not have permission to perform this action/i;
const TOKEN_REJECTED_TEXT = /not currently configured to accept this token/i;
const TOKEN_REJECTED_HINT = 'The server did not accept this Microsoft account. Check that the server has a Microsoft Entra admin and that the account is a user in the database, or sign in with another account.';
const SIGN_IN_TEXT = /Microsoft sign-in did not complete|User did not consent to login/i;
const CANNOT_OPEN_DATABASE_TEXT = /Cannot open database\s+["'].+["']\s+requested by the login|not able to access the database/i;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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
 * Whether an error came from the SQL driver rather than from this extension's own logic.
 *
 * @remarks
 * Driver errors carry a numeric SQL Server error number or an `E…` code (`ELOGIN`, `ETIMEOUT`,
 * `ESOCKET`, `EREQUEST`).
 */
export function isDriverError(err: unknown): boolean {
  return errorNumber(err) !== undefined || /^E[A-Z]+$/.test(errorCode(err) ?? '');
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

const bracket = (identifier: string): string => `[${identifier.replace(/\]/g, ']]')}]`;

function grantStatement(user: string | undefined): string {
  const principal = user ? bracket(user) : '[user_or_group]';
  return `GRANT VIEW DEFINITION TO ${principal};`;
}

/**
 * Describes a connection or query failure for the user.
 *
 * @remarks
 * `message` is `<connection name>: <original driver text>` with credential-shaped text removed, plus
 * one hint when the server rejects a Microsoft token. The
 * actions depend on the error class; those that manage a saved built-in connection are offered only
 * for the built-in provider, and Retry only when the caller supplies a retry hook. Each action runs
 * on the user's click and any retry it triggers is a single attempt, never a loop.
 *
 * @param err - The raw error from the driver or the mssql extension.
 * @param target - The connection the error belongs to.
 * @param hooks - Caller-supplied capabilities the actions use.
 */
export function describeConnectionError(
  err: unknown,
  target: ConnectionErrorTarget,
  hooks: ConnectionErrorHooks = {},
): { message: string; actions: ConnectionErrorAction[] } {
  const kind = classify(err);
  const message = `${target.name}: ${redactSecrets(errorMessage(err))}${kind === 'tokenRejected' ? ` ${TOKEN_REJECTED_HINT}` : ''}`;
  const builtIn = target.provider === 'builtIn' && !!target.connectionId;
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
      if (!await confirmTrustServerCertificate(saved)) return;
      await upsertBuiltInConnection({ ...saved, trustServerCertificate: true });
      await retry({ trustServerCertificate: true });
    }),
    retry: () => make('retry', () => retry()),
    copyGrantStatement: () => make('copyGrantStatement', async () => {
      await vscode.env.clipboard.writeText(grantStatement(target.user));
      void vscode.window.showInformationMessage('GRANT statement copied to the clipboard.');
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
 * Asks, in a modal, whether to trust a server certificate without validating it.
 *
 * @param connection - The server the certificate belongs to.
 * @returns `true` only when the user confirmed.
 */
export async function confirmTrustServerCertificate(connection: Pick<BuiltInConnection, 'server' | 'port' | 'database'>): Promise<boolean> {
  const confirmed = await vscode.window.showWarningMessage(
    `Trust the certificate of ${describeConnection(connection)} without validating it? Do this only for a server you know uses a self-signed certificate, such as a development or test server.`,
    { modal: true },
    TRUST_CERTIFICATE,
  );
  return confirmed === TRUST_CERTIFICATE;
}

/**
 * Logs a connection error once, shows it with its actions, and runs the action the user picks.
 *
 * @remarks
 * Redacted driver detail goes to the log at debug level; the toast carries the described message, never
 * the raw error alone. The returned `message` is for callers that also show the text inline.
 *
 * @returns The described message, and a promise that settles once the toast is answered or dismissed.
 */
export function reportConnectionError(
  err: unknown,
  target: ConnectionErrorTarget,
  logger: Pick<Logger, 'info' | 'warn' | 'debug'>,
  hooks: ConnectionErrorHooks = {},
  present: (message: string, ...labels: string[]) => Thenable<string | undefined> = vscode.window.showErrorMessage,
): { message: string; actions: ConnectionErrorAction[]; answered: Promise<void> } {
  const { message, actions } = describeConnectionError(err, target, hooks);
  logger.info('Database connection failed');
  logger.debug(`Connection error on ${target.name} — code=${errorCode(err) ?? '-'} number=${errorNumber(err) ?? '-'} raw="${redactSecrets(errorMessage(err))}"`);
  const answered = (async () => {
    const choice = await present(message, ...actions.map((a) => a.label));
    const chosen = actions.find((a) => a.label === choice);
    if (!chosen) return;
    try {
      await chosen.run();
    } catch (actionErr) {
      logger.warn(`Action "${chosen.label}" failed`);
      logger.debug(`Connection action error: ${redactSecrets(errorMessage(actionErr))}`);
    }
  })();
  return { message, actions, answered };
}

/**
 * Builds the error target for a session that is already open.
 *
 * @param session - The open session.
 */
export function targetFromSession(session: DbSession): ConnectionErrorTarget {
  return targetFromStored(session.connectionInfo, session.provider);
}

/**
 * Builds the error target for a stored connection record.
 *
 * @param info - The stored record.
 * @param provider - The provider that is connecting.
 */
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

/** Narrows an error to the connect failure {@link DbConnectionError}. */
export function isDbConnectionError(err: unknown): err is DbConnectionError {
  return err instanceof DbConnectionError;
}
