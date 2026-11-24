/**
 * Schema and helpers for the built-in connections stored in `dataLineageViz.database.connections`.
 * Passwords never live there; they use the secret store.
 */

import { z } from 'zod';
import type { Logger } from '../../utils/log';
import type { StoredConnectionInfo } from '../shared/bridgeContract';

/** The secret-store calls the connections use; `vscode.SecretStorage` satisfies it. */
export interface SecretStore {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

/** Secret-store key prefix; the connection id is appended. */
const PASSWORD_SECRET_PREFIX = 'dataLineageViz.database.password.';

/** Secret-store key holding the SQL login password of one built-in connection. */
export function passwordSecretKey(id: string): string {
  return `${PASSWORD_SECRET_PREFIX}${id}`;
}

/** The identity a saved password was entered for. */
type PasswordBinding = Pick<BuiltInConnection, 'id' | 'server' | 'port' | 'user'>;

const SavedPasswordSchema = z.object({
  server: z.string(), port: z.number().optional(), user: z.string(), password: z.string(),
});

function bindingOf(connection: PasswordBinding): { server: string; port?: number; user: string } {
  return { server: dropTcpPrefix(connection.server).toLowerCase(), port: connection.port, user: connection.user ?? '' };
}

/** Secret-store value for a password, bound to the server, port and user it was entered for. @internal */
export function encodeSavedPassword(connection: PasswordBinding, password: string): string {
  return JSON.stringify({ ...bindingOf(connection), password });
}

/** Stores the SQL login password of a connection, bound to its server, port and user. */
export async function savePassword(
  secrets: Pick<SecretStore, 'store'>, connection: PasswordBinding, password: string,
): Promise<void> {
  await secrets.store(passwordSecretKey(connection.id), encodeSavedPassword(connection, password));
}

/**
 * Reads the saved SQL login password of a connection. A password saved for another server, port or
 * user (e.g. after `settings.json` was edited to point the connection elsewhere) or an unreadable
 * value counts as no saved password, so it is never sent to a host it was not entered for.
 */
export async function readSavedPassword(
  secrets: Pick<SecretStore, 'get'>, connection: PasswordBinding, logger: Pick<Logger, 'warn'>,
): Promise<string | undefined> {
  const raw = await secrets.get(passwordSecretKey(connection.id));
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
  const saved = SavedPasswordSchema.safeParse(parsed);
  if (!saved.success) {
    logger.warn('Saved password ignored — code=saved_password_unreadable');
    return undefined;
  }
  const expected = bindingOf(connection);
  const matches = saved.data.server === expected.server && saved.data.port === expected.port && saved.data.user === expected.user;
  return matches ? saved.data.password : undefined;
}

/** Highest valid TCP port. */
const MAX_TCP_PORT = 65535;

/** SQL Server `sysname` length: bounds logins and database names. */
export const MAX_SYSNAME_LENGTH = 128;
const MAX_PASSWORD_LENGTH = 128;
/** Input-box validation message for a password SQL Server cannot accept, or `undefined`. */
export function passwordTooLong(value: string): string | undefined {
  return value.length > MAX_PASSWORD_LENGTH ? `A password has at most ${MAX_PASSWORD_LENGTH} characters.` : undefined;
}

/** A DNS name (253) plus a `tcp:` prefix, a `\\instance` name and a `,port` suffix. */
export const MAX_SERVER_LENGTH = 512;
/** Room for the suggested display name `server,port / database` built from the longest of each. */
export const MAX_NAME_LENGTH = 1024;

/** Input-box message for a value over `max`, or `undefined`; `what` names the field. */
export function tooLong(value: string, max: number, what: string): string | undefined {
  return value.trim().length > max ? `A ${what} has at most ${max} characters.` : undefined;
}
/** A tenant is a GUID or a verified domain name. */
const MAX_TENANT_LENGTH = 253;

const TCP_PREFIX = /^tcp:/i;
const INSTANCE_SEPARATOR = '\\';
const BRACKETED_HOST = /^\[(.+)\]$/;

function unbracket(host: string): string {
  return host.replace(BRACKETED_HOST, '$1');
}

/** Removes a leading `tcp:` from a server address, as Azure portal connection strings carry it. */
function dropTcpPrefix(server: string): string {
  return server.trim().replace(TCP_PREFIX, '').trim();
}

/** Host names of Azure SQL in the public, US government and China clouds. */
export const AZURE_SQL_HOST = /\.database\.(windows\.net|usgovcloudapi\.net|chinacloudapi\.cn)$/i;

/**
 * Splits a server address the way SqlClient and the mssql extension read it: a leading `tcp:` is
 * dropped, a bracketed IPv6 address `[fe80::1]` loses its brackets, and `host\instance` becomes the
 * host and the named instance the SQL Browser service resolves to a port.
 */
export function resolveServerAddress(server: string): { host: string; instanceName?: string } {
  const address = dropTcpPrefix(server);
  const at = address.indexOf(INSTANCE_SEPARATOR);
  const host = unbracket(at < 0 ? address : address.slice(0, at));
  const instanceName = at < 0 ? '' : address.slice(at + 1);
  return instanceName ? { host, instanceName } : { host };
}

const connectionFields = {
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  server: z.string().min(1).max(MAX_SERVER_LENGTH),
  port: z.number().int().min(1).max(MAX_TCP_PORT).optional(),
  database: z.string().min(1).max(MAX_SYSNAME_LENGTH).optional(),
  /** Windows authentication is unsupported: the bundled driver has no integrated sign-in. */
  authenticationType: z.enum(['sqlLogin', 'entraId']),
  user: z.string().min(1).max(MAX_SYSNAME_LENGTH).optional(),
  accountId: z.string().min(1).max(MAX_SYSNAME_LENGTH).optional(),
  tenantId: z.string().min(1).max(MAX_TENANT_LENGTH).optional(),
  encrypt: z.boolean().optional(),
  trustServerCertificate: z.boolean().optional(),
};

/**
 * A built-in connection as stored in settings. Not `.strict()`: an unrecognized property,
 * `password` above all, is dropped on parse, so a hand-edited entry can never route a credential
 * from settings into a connection.
 */
export const BuiltInConnectionSchema = z.object({ id: z.string().min(1).max(MAX_SYSNAME_LENGTH), ...connectionFields });

/** {@link BuiltInConnectionSchema} with an optional id, for callers letting the host assign one. */
const BuiltInConnectionInputSchema = z.object({ id: z.string().min(1).max(MAX_SYSNAME_LENGTH).optional(), ...connectionFields });

export type BuiltInConnection = z.infer<typeof BuiltInConnectionSchema>;

/** Argument of `dataLineageViz.addDatabaseConnection` that skips every prompt. */
export const AddConnectionArgsSchema = z.object({
  connection: BuiltInConnectionInputSchema,
  password: z.string().max(MAX_PASSWORD_LENGTH).optional(),
});

/** Human-readable `server / database` label. */
export function describeConnection(connection: Pick<BuiltInConnection, 'server' | 'database' | 'port'>): string {
  const host = connection.port ? `${connection.server},${connection.port}` : connection.server;
  return connection.database ? `${host} / ${connection.database}` : host;
}

/**
 * Parses the wizard's server field (`host` or `host,port`, optional `tcp:` prefix dropped);
 * `undefined` when the text is not a valid server.
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

/** Built-in sign-in type a stored record names; the mssql extension's spellings read too. */
function storedAuthKind(authenticationType: string | undefined): BuiltInConnection['authenticationType'] | undefined {
  const value = authenticationType?.toLowerCase() ?? '';
  if (value === 'sqllogin') return 'sqlLogin';
  return value === 'entraid' || value.startsWith('azure') || value.startsWith('activedirectory') ? 'entraId' : undefined;
}

/** Port SQL Server listens on when none is given; a named instance has none. */
const DEFAULT_SQL_PORT = 1433;

/**
 * Finds the saved built-in connection that reopens a stored project. A saved `connectionId` wins.
 * Otherwise: same server (`tcp:` prefix ignored) and effective port (a `host,port` string is split
 * first, an absent port is the default one; a named instance has a dynamic port, so an absent port
 * matches any) and the same sign-in type and user where both sides name one. Among several matches
 * the one saved for the project's database is preferred, then the first; the project's own database
 * is opened either way.
 */
export function findBuiltInMatch(connections: BuiltInConnection[], stored: StoredConnectionInfo): BuiltInConnection | undefined {
  const byId = stored.connectionId ? connections.find((c) => c.id === stored.connectionId) : undefined;
  if (byId) return byId;
  const same = (a?: string, b?: string) => !a || !b || a.toLowerCase() === b.toLowerCase();
  const kind = storedAuthKind(stored.authenticationType);
  const host = parseServerInput(stored.server) ?? { server: stored.server };
  const defaultPort = host.server.includes('\\') ? undefined : DEFAULT_SQL_PORT;
  const port = stored.port ?? host.port ?? defaultPort;
  const matches = connections.filter((c) => dropTcpPrefix(c.server).toLowerCase() === host.server.toLowerCase()
    && (defaultPort === undefined ? !c.port || !port || c.port === port : (c.port ?? defaultPort) === port)
    && (!kind || c.authenticationType === kind)
    && same(c.user, stored.user));
  return matches.find((c) => same(c.database, stored.database) && !!c.database) ?? matches[0];
}
