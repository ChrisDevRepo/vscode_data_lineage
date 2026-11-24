/** The built-in connections saved in `dataLineageViz.database.connections` (user settings). */

import * as vscode from 'vscode';
import type { Logger } from '../utils/log';
import { DATABASE_CONFIG_SECTION } from '../engine/db/dbSession';
import { BuiltInConnectionSchema, type BuiltInConnection } from '../engine/db/connectionSettings';
import { rawId, rewriteRawList } from './rawSettingList';

const CONNECTIONS_SETTING = 'connections';

/**
 * Reads the saved built-in connections, tolerantly: an entry that fails validation is skipped with
 * a debug log (`logger`) naming its position and the failing fields, never its values.
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
 * Adds a connection, or replaces the saved one with the same id. Every other entry is written back
 * as stored, including a hand-edited one that fails validation. Serialized with
 * {@link deleteBuiltInConnection}, so concurrent calls never drop an entry.
 */
export function upsertBuiltInConnection(connection: BuiltInConnection): Promise<void> {
  return rewriteRawList(DATABASE_CONFIG_SECTION, CONNECTIONS_SETTING, (entries) => {
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
  return rewriteRawList(DATABASE_CONFIG_SECTION, CONNECTIONS_SETTING, (entries) => entries.filter((entry) => rawId(entry) !== id));
}
