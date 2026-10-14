/**
 * @module DbSession
 * Built-in database session contract.
 */

import type { SimpleExecuteResult, IServerInfo } from '../../types/database';
import type { StoredConnectionInfo } from '../shared/bridgeContract';
import { errorMessage } from '../../utils/errorMessage';

/** Configuration section that owns the connection settings. */
export const DATABASE_CONFIG_SECTION = 'dataLineageViz.database';

/** Per-request limits a caller may impose on {@link DbSession.executeSimpleQuery}. */
export interface DbQueryOptions {
  /** Budget in milliseconds; the session cancels the request on the wire when it is spent, then rejects. Callers add no timer of their own. */
  timeoutMs?: number;
  /** Error message used when the budget is spent. */
  timeoutMessage?: string;
}

/**
 * One open database connection.
 *
 * @remarks
 * Consumers read result cells by column name, so a provider must return `displayValue` strings in
 * a consistent display format.
 */
export interface DbSession {
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
    super(errorMessage(original));
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
