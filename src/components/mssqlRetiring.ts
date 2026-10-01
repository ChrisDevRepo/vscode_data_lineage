/**
 * @module MssqlRetiring
 * Wording and detection for connections made through the SQL Server (mssql) extension's retiring
 * connection API.
 */

import type { Project } from '../engine/projectStore';

/** Notice next to the database source while the mssql extension provider is selected. */
export const MSSQL_RETIRING_NOTICE =
  "This connection uses the SQL Server (mssql) extension's connection API, which Microsoft is retiring. Use the built-in connection instead.";

/** Hint on a saved project that still connects through the mssql extension. */
export const MSSQL_PROJECT_HINT =
  'Uses the deprecated SQL Server (mssql) extension connection. Recommended: migrate to the built-in connection — open the project while built-in connections are selected.';

/** SVG path of the warning triangle shown with both texts. */
export const WARNING_ICON_PATH =
  'M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z';

/**
 * Whether a saved project connects through the mssql extension.
 *
 * @remarks
 * A stored connection without `provider` was written for the mssql extension, as the connection
 * manager reads it.
 */
export function usesMssqlExtension(project: Project): boolean {
  return project.connection.type === 'database' && (project.connection.connectionInfo.provider ?? 'mssqlExtension') === 'mssqlExtension';
}
