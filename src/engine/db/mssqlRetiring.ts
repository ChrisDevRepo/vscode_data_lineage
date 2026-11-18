/**
 * @module MssqlRetiring
 * Wording and detection for a project saved with the SQL Server (mssql) extension connection, which
 * Microsoft deprecated and this extension no longer opens.
 */

import type { StoredConnectionInfo } from '../shared/bridgeContract';

/** Warning shown when a project saved with the mssql extension connection opens. */
export const MSSQL_RECONNECT_NOTICE =
  'Microsoft deprecated the SQL Server (mssql) extension connection, which Data Lineage no longer supports. Add Database Connection opens with the saved server and database; the project keeps its schemas.';

/** Whether a stored connection was written for the mssql extension; no `provider` predates it. */
export function usesMssqlExtension(stored: StoredConnectionInfo): boolean {
  return (stored.provider ?? 'mssqlExtension') === 'mssqlExtension';
}
