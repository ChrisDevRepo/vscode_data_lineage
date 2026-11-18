/**
 * @module MssqlRetiring
 * Wording and detection for a project saved with the SQL Server (mssql) extension connection, which
 * Microsoft deprecated and this extension no longer opens.
 */

import type { StoredConnectionInfo } from '../shared/bridgeContract';

/** Warning shown when a project saved with the mssql extension connection opens. */
export const MSSQL_RECONNECT_NOTICE =
  "This project's SQL Server (mssql) extension connection is no longer supported. Reconnect with Data Lineage: Add Database Connection.";

/** Whether a stored connection was written for the mssql extension; no `provider` predates it. */
export function usesMssqlExtension(stored: StoredConnectionInfo): boolean {
  return (stored.provider ?? 'mssqlExtension') === 'mssqlExtension';
}
