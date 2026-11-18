/**
 * @module DbSession
 * Database session contract of the built-in connection.
 */

import type { SimpleExecuteResult, IServerInfo } from '../../types/database';
import type { ConnectionProviderId, StoredConnectionInfo } from '../shared/bridgeContract';

export type { ConnectionProviderId };

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
 * One open database connection; consumers read cells by column name, so it must return
 * `displayValue` strings.
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
 * A failed connect, keeping the original driver error untouched: `message` is the driver's own
 * text, and presentation (name prefix, actions) is added by `describeConnectionError`, never by
 * rewriting the error.
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
