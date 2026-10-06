/**
 * @module ConnectionSettings
 * Schema, tolerant read and write helpers for the built-in connections stored in
 * `dataLineageViz.database.connections`. Passwords never live there; they use the secret store.
 */

import * as vscode from 'vscode';
import { z } from 'zod';
import type { Logger } from '../../utils/log';
import { DATABASE_CONFIG_SECTION } from './dbSession';

/** Setting key, relative to {@link DATABASE_CONFIG_SECTION}, that holds the built-in connection list. */
export const CONNECTIONS_SETTING = 'connections';

/** Secret-store key prefix; the connection id is appended. */
const PASSWORD_SECRET_PREFIX = 'dataLineageViz.database.password.';

/**
 * Secret-store key holding the SQL login password of one built-in connection.
 *
 * @param id - The connection id.
 */
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

/**
 * Secret-store value for a password, bound to the server, port and user it was entered for.
 *
 * @param connection - The connection the password belongs to.
 * @param password - The SQL login password.
 */
export function encodeSavedPassword(connection: PasswordBinding, password: string): string {
  return JSON.stringify({ ...bindingOf(connection), password });
}

/**
 * Stores the SQL login password of a connection, bound to its server, port and user.
 *
 * @param secrets - VS Code secret storage.
 * @param connection - The connection the password belongs to.
 * @param password - The SQL login password.
 */
export async function savePassword(
  secrets: Pick<vscode.SecretStorage, 'store'>, connection: PasswordBinding, password: string,
): Promise<void> {
  await secrets.store(passwordSecretKey(connection.id), encodeSavedPassword(connection, password));
}

/**
 * Reads the saved SQL login password of a connection.
 *
 * @remarks
 * A password saved for another server, port or user — for example after `settings.json` was edited
 * to point the connection elsewhere — or an unreadable value counts as no saved password, so it is
 * never sent to a host it was not entered for.
 *
 * @param secrets - VS Code secret storage.
 * @param connection - The connection to read the password for.
 */
export async function readSavedPassword(
  secrets: Pick<vscode.SecretStorage, 'get'>, connection: PasswordBinding,
): Promise<string | undefined> {
  const raw = await secrets.get(passwordSecretKey(connection.id));
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  const saved = SavedPasswordSchema.safeParse(parsed);
  if (!saved.success) return undefined;
  const expected = bindingOf(connection);
  const matches = saved.data.server === expected.server && saved.data.port === expected.port && saved.data.user === expected.user;
  return matches ? saved.data.password : undefined;
}

const MAX_TCP_PORT = 65535;

/** SQL Server `sysname` length: bounds logins and database names. */
export const MAX_SYSNAME_LENGTH = 128;
/** SQL Server maximum password length. */
export const MAX_PASSWORD_LENGTH = 128;
/** Input-box validation message for a password SQL Server cannot accept, or `undefined`. */
export function passwordTooLong(value: string): string | undefined {
  return value.length > MAX_PASSWORD_LENGTH ? `A password has at most ${MAX_PASSWORD_LENGTH} characters.` : undefined;
}

/** A DNS name (253) plus a `tcp:` prefix, a `\\instance` name and a `,port` suffix. */
export const MAX_SERVER_LENGTH = 512;
/** Room for the suggested display name `server,port / database` built from the longest of each. */
export const MAX_NAME_LENGTH = 1024;

/**
 * Input-box validation message for a value longer than `max`, or `undefined`.
 *
 * @param value - The typed value.
 * @param max - The longest accepted value.
 * @param what - The field, as it reads in "A <what> has at most …".
 */
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

/** Removes the leading `tcp:` protocol prefix of a server address, as the Azure portal connection strings carry it. */
export function dropTcpPrefix(server: string): string {
  return server.trim().replace(TCP_PREFIX, '').trim();
}

/**
 * Splits a server address the way SqlClient and the mssql extension read it.
 *
 * @remarks
 * A leading `tcp:` prefix is dropped, a bracketed IPv6 address `[fe80::1]` loses its brackets, and
 * `host\instance` becomes the host and the named instance the SQL Browser service resolves to a port.
 *
 * @param server - The address as typed or stored.
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
  /** Windows authentication is not supported: the bundled driver has no integrated Windows sign-in. */
  authenticationType: z.enum(['sqlLogin', 'entraId']),
  user: z.string().min(1).max(MAX_SYSNAME_LENGTH).optional(),
  accountId: z.string().min(1).max(MAX_SYSNAME_LENGTH).optional(),
  tenantId: z.string().min(1).max(MAX_TENANT_LENGTH).optional(),
  encrypt: z.boolean().optional(),
  trustServerCertificate: z.boolean().optional(),
};

/**
 * A built-in connection as stored in settings.
 *
 * @remarks
 * Not `.strict()`: an unrecognized property, `password` above all, is dropped on parse rather than
 * kept, so a hand-edited entry can never route a credential from settings into a connection.
 */
export const BuiltInConnectionSchema = z.object({ id: z.string().min(1).max(MAX_SYSNAME_LENGTH), ...connectionFields });

/** {@link BuiltInConnectionSchema} with the id optional, for callers that let the extension assign one. */
export const BuiltInConnectionInputSchema = z.object({ id: z.string().min(1).max(MAX_SYSNAME_LENGTH).optional(), ...connectionFields });

/** A validated built-in connection. */
export type BuiltInConnection = z.infer<typeof BuiltInConnectionSchema>;

/** Argument of `dataLineageViz.addDatabaseConnection` that skips every prompt. */
export const AddConnectionArgsSchema = z.object({
  connection: BuiltInConnectionInputSchema,
  password: z.string().max(MAX_PASSWORD_LENGTH).optional(),
});

/**
 * Reads the saved built-in connections.
 *
 * @remarks
 * Tolerant: an entry that fails validation is skipped with a debug log naming its position and the
 * failing fields, never its values.
 *
 * @param logger - Receives one debug line per skipped entry or ignored property.
 */
export function readBuiltInConnections(logger?: Pick<Logger, 'debug'>): BuiltInConnection[] {
  const raw = vscode.workspace.getConfiguration(DATABASE_CONFIG_SECTION).get<unknown>(CONNECTIONS_SETTING);
  if (!Array.isArray(raw)) return [];
  const connections: BuiltInConnection[] = [];
  raw.forEach((entry, index) => {
    const parsed = BuiltInConnectionSchema.safeParse(entry);
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || 'entry'))].join(', ');
      logger?.debug(`Skipped built-in connection #${index + 1}: invalid ${fields}`);
      return;
    }
    if (entry && typeof entry === 'object') {
      const ignored = Object.keys(entry).filter((k) => !(k in parsed.data));
      if (ignored.length > 0) logger?.debug(`Built-in connection "${parsed.data.name}": ignored properties ${ignored.join(', ')}`);
    }
    connections.push(parsed.data);
  });
  return connections;
}

/** A copy of the raw setting value, as the user's settings.json holds it. */
function readRawConnections(): unknown[] {
  const raw = vscode.workspace.getConfiguration(DATABASE_CONFIG_SECTION).get<unknown>(CONNECTIONS_SETTING);
  return Array.isArray(raw) ? [...raw] : [];
}

function rawId(entry: unknown): unknown {
  return entry && typeof entry === 'object' ? (entry as { id?: unknown }).id : undefined;
}

/** Tail of the connection-list rewrites; each read-modify-write starts after the previous one settles. */
let rewriteTail: Promise<unknown> = Promise.resolve();

/**
 * Rewrites the connection list in the user (global) settings, one rewrite at a time.
 *
 * @remarks
 * The setting is application-scoped, so a workspace can neither hold nor override it. `change` reads
 * the list only after every earlier rewrite has landed, so concurrent saves never drop each other's
 * entries. A failed rewrite rejects its own caller and does not block the next one.
 */
function rewriteConnections(change: (entries: unknown[]) => unknown[]): Promise<void> {
  const run = async (): Promise<void> => {
    await vscode.workspace.getConfiguration(DATABASE_CONFIG_SECTION)
      .update(CONNECTIONS_SETTING, change(readRawConnections()), vscode.ConfigurationTarget.Global);
  };
  const result = rewriteTail.then(run, run);
  rewriteTail = result.catch(() => undefined);
  return result;
}

/**
 * Adds a connection, or replaces the saved one with the same id.
 *
 * @remarks
 * Every other entry is written back as stored, including a hand-edited one that fails validation.
 * Serialized with {@link deleteBuiltInConnection}, so concurrent calls never drop an entry.
 */
export function upsertBuiltInConnection(connection: BuiltInConnection): Promise<void> {
  return rewriteConnections((entries) => {
    const at = entries.findIndex((entry) => rawId(entry) === connection.id);
    if (at >= 0) entries[at] = connection;
    else entries.push(connection);
    return entries;
  });
}

/**
 * Removes the saved connection with the given id; every other entry is written back as stored.
 * Serialized with {@link upsertBuiltInConnection}.
 */
export function deleteBuiltInConnection(id: string): Promise<void> {
  return rewriteConnections((entries) => entries.filter((entry) => rawId(entry) !== id));
}

/** Human-readable `server / database` label. */
export function describeConnection(connection: Pick<BuiltInConnection, 'server' | 'database' | 'port'>): string {
  const host = connection.port ? `${connection.server},${connection.port}` : connection.server;
  return connection.database ? `${host} / ${connection.database}` : host;
}
