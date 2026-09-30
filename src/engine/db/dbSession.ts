/**
 * @module DbSession
 * Provider-neutral database session contract shared by the mssql-extension and built-in providers.
 */

import * as vscode from 'vscode';
import type { SimpleExecuteResult, IServerInfo } from '../../types/mssql';
import type { ConnectionProviderId, StoredConnectionInfo } from '../shared/bridgeContract';

export type { ConnectionProviderId };

/** Provider used when `dataLineageViz.database.connectionProvider` is unset or holds an unknown value. */
export const DEFAULT_CONNECTION_PROVIDER: ConnectionProviderId = 'mssqlExtension';

/** Configuration section that owns the connection settings. */
export const DATABASE_CONFIG_SECTION = 'dataLineageViz.database';

/** Per-request limits a caller may impose on {@link DbSession.executeSimpleQuery}. */
export interface DbQueryOptions {
  /** Budget in milliseconds; a provider that owns the wire cancels the request when it is spent. */
  timeoutMs?: number;
  /** Error message used when the budget is spent. */
  timeoutMessage?: string;
}

/**
 * One open database connection.
 *
 * @remarks
 * Consumers read result cells by column name, so a provider must return `displayValue` strings in
 * the form the mssql extension renders them.
 */
export interface DbSession {
  /** The provider that opened this session. */
  readonly provider: ConnectionProviderId;
  /** Persistable, credential-free description of the connection. */
  readonly connectionInfo: StoredConnectionInfo;
  /** Runs one SQL batch and resolves with its first result set. */
  executeSimpleQuery(sql: string, options?: DbQueryOptions): Promise<SimpleExecuteResult>;
  /** Reads server version and edition metadata. */
  getServerInfo(): Promise<IServerInfo>;
  /** Releases what this extension opened; safe to call more than once. */
  dispose(): Promise<void>;
}

/**
 * Reads the active provider from `dataLineageViz.database.connectionProvider`.
 *
 * @returns `builtIn` or `mssqlExtension`; any other stored value reads as the default.
 */
export function getConnectionProvider(): ConnectionProviderId {
  const value = vscode.workspace.getConfiguration(DATABASE_CONFIG_SECTION).get<string>('connectionProvider');
  return value === 'builtIn' ? 'builtIn' : DEFAULT_CONNECTION_PROVIDER;
}

/** Identifies the connection an error belongs to; carries no credential. */
export interface ConnectionErrorTarget {
  /** Provider that was connecting. */
  provider: ConnectionProviderId;
  /** Display name shown in front of the driver message. */
  name: string;
  /** Server host name or address. */
  server: string;
  /** TCP port, when not the default. */
  port?: number;
  /** Database the connection was opening. */
  database?: string;
  /** SQL login user name. */
  user?: string;
  /** `sqlLogin` or `entraId` for built-in connections. */
  authenticationType?: string;
  /** Id of the saved built-in connection. */
  connectionId?: string;
  /** Microsoft tenant id used for sign-in. */
  tenantId?: string;
}

/**
 * A failed connect, keeping the original driver error untouched.
 *
 * @remarks
 * `message` is the driver's own text. Presentation (name prefix, actions) is added by
 * `describeConnectionError`, never by rewriting the error.
 */
export class DbConnectionError extends Error {
  constructor(readonly target: ConnectionErrorTarget, readonly original: unknown) {
    super(original instanceof Error ? original.message : String(original));
    this.name = 'DbConnectionError';
  }
}

/** The Microsoft sign-in that a built-in Entra connection needs did not complete. */
export class MicrosoftSignInError extends Error {
  constructor(reason: string) {
    super(`Microsoft sign-in did not complete: ${reason}`);
    this.name = 'MicrosoftSignInError';
  }
}
