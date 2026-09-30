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

const MAX_TCP_PORT = 65535;

const TCP_PREFIX = /^tcp:/i;
const INSTANCE_SEPARATOR = '\\';

/** Removes the leading `tcp:` protocol prefix of a server address, as the Azure portal connection strings carry it. */
export function dropTcpPrefix(server: string): string {
  return server.trim().replace(TCP_PREFIX, '').trim();
}

/**
 * Splits a server address the way SqlClient and the mssql extension read it.
 *
 * @remarks
 * A leading `tcp:` prefix is dropped, and `host\instance` becomes the host and the named instance the
 * SQL Browser service resolves to a port.
 *
 * @param server - The address as typed or stored.
 */
export function resolveServerAddress(server: string): { host: string; instanceName?: string } {
  const address = dropTcpPrefix(server);
  const at = address.indexOf(INSTANCE_SEPARATOR);
  if (at < 0) return { host: address };
  const instanceName = address.slice(at + 1);
  return instanceName ? { host: address.slice(0, at), instanceName } : { host: address.slice(0, at) };
}

const connectionFields = {
  name: z.string().min(1),
  server: z.string().min(1),
  port: z.number().int().min(1).max(MAX_TCP_PORT).optional(),
  database: z.string().min(1).optional(),
  authenticationType: z.enum(['sqlLogin', 'entraId']),
  user: z.string().min(1).optional(),
  tenantId: z.string().min(1).optional(),
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
export const BuiltInConnectionSchema = z.object({ id: z.string().min(1), ...connectionFields });

/** {@link BuiltInConnectionSchema} with the id optional, for callers that let the extension assign one. */
export const BuiltInConnectionInputSchema = z.object({ id: z.string().min(1).optional(), ...connectionFields });

/** A validated built-in connection. */
export type BuiltInConnection = z.infer<typeof BuiltInConnectionSchema>;

/** Argument of `dataLineageViz.addDatabaseConnection` that skips every prompt. */
export const AddConnectionArgsSchema = z.object({
  connection: BuiltInConnectionInputSchema,
  password: z.string().optional(),
});

/** Validated argument of `dataLineageViz.addDatabaseConnection`. */
export type AddConnectionArgs = z.infer<typeof AddConnectionArgsSchema>;

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

/**
 * Writes the connection list to the user (global) settings.
 *
 * @remarks
 * The setting is application-scoped, so a workspace can neither hold nor override it.
 */
async function writeBuiltInConnections(connections: BuiltInConnection[]): Promise<void> {
  await vscode.workspace.getConfiguration(DATABASE_CONFIG_SECTION)
    .update(CONNECTIONS_SETTING, connections, vscode.ConfigurationTarget.Global);
}

/** Adds a connection, or replaces the saved one with the same id. */
export async function upsertBuiltInConnection(connection: BuiltInConnection, logger?: Pick<Logger, 'debug'>): Promise<void> {
  const saved = readBuiltInConnections(logger);
  const at = saved.findIndex((c) => c.id === connection.id);
  if (at >= 0) saved[at] = connection;
  else saved.push(connection);
  await writeBuiltInConnections(saved);
}

/** Removes the saved connection with the given id. */
export async function deleteBuiltInConnection(id: string, logger?: Pick<Logger, 'debug'>): Promise<void> {
  await writeBuiltInConnections(readBuiltInConnections(logger).filter((c) => c.id !== id));
}

/** Human-readable `server / database` label. */
export function describeConnection(connection: Pick<BuiltInConnection, 'server' | 'database' | 'port'>): string {
  const host = connection.port ? `${connection.server},${connection.port}` : connection.server;
  return connection.database ? `${host} / ${connection.database}` : host;
}
