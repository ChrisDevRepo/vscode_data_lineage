/**
 * Type declarations for the MSSQL extension API.
 *
 * Source: vscode-mssql/typings/vscode-mssql.d.ts (MIT license)
 * Only the subset used by Data Lineage Viz is declared here.
 *
 * Two API surfaces:
 *  - IExtension (main export): promptForConnection(), connect()
 *  - IConnectionSharingService (v1.34+): executeSimpleQuery()
 */

export interface DbCellValue {
  /**
   * Formatted cell value returned by MSSQL.
   */
  displayValue: string;
  /**
   * Whether the cell value is `NULL`.
   */
  isNull: boolean;
}

/**
 * Subset of `vscode-mssql` column metadata used by this extension.
 */
export interface IDbColumn {
  /**
   * Column name reported by MSSQL.
   */
  columnName: string;
  /**
   * Database-specific type identifier.
   */
  dataType: string;
  /**
   * Display name of the SQL data type.
   */
  dataTypeName: string;
  /**
   * Whether the column allows `NULL` values.
   */
  allowDBNull?: boolean;
  /**
   * Ordinal position of the column in the result set.
   */
  columnOrdinal?: number;
}

/**
 * Subset of `vscode-mssql` query results used by this extension.
 */
export interface SimpleExecuteResult {
  /**
   * Number of rows returned or affected by the query.
   */
  rowCount: number;
  /**
   * Metadata for the result columns.
   */
  columnInfo: IDbColumn[];
  /**
   * Tabular query result rows.
   */
  rows: DbCellValue[][];
}

/**
 * Subset of `vscode-mssql` server metadata used by this extension.
 */
export interface IServerInfo {
  /**
   * Major SQL Server version number.
   */
  serverMajorVersion: number;
  /**
   * Minor SQL Server version number.
   */
  serverMinorVersion: number;
  /**
   * Full SQL Server version string.
   */
  serverVersion: string;
  /**
   * SQL engine edition identifier.
   */
  engineEditionId: number;
  /**
   * Whether the server runs in a cloud environment.
   */
  isCloud: boolean;
  /**
   * Edition name reported by the server.
   */
  serverEdition: string;
}

/** Connection info returned by promptForConnection() */
export interface IConnectionInfo {
  /**
   * Server name or address.
   */
  server: string;
  /**
   * Database name.
   */
  database: string;
  /**
   * User name used for the connection.
   */
  user: string;
  /**
   * Password used for the connection, when required.
   */
  password?: string;
  /**
   * Authentication mode selected in MSSQL.
   */
  authenticationType: string;
  /**
   * Account email for cloud authentication, when present.
   */
  email?: string;
  /**
   * MSSQL account identifier, when present.
   */
  accountId?: string;
  /**
   * Tenant identifier for cloud authentication, when present.
   */
  tenantId?: string;
  /**
   * Server port.
   */
  port: number;
  /**
   * Encryption setting returned by MSSQL.
   */
  encrypt?: string | boolean;
  /**
   * Whether the server certificate is trusted without validation.
   */
  trustServerCertificate?: boolean;
  /**
   * Raw connection string, when available.
   */
  connectionString?: string;
}

/** Connection-Sharing API (v1.34+) — used for executeSimpleQuery */
export interface IConnectionSharingService {
  /**
   * Returns the connection ID for the active editor.
   */
  getActiveEditorConnectionId(extensionId: string): Promise<string | undefined>;
  /**
   * Connects the shared session to a database.
   */
  connect(extensionId: string, connectionId: string, database?: string): Promise<string>;
  /**
   * Executes a SQL query and returns the raw result.
   */
  executeSimpleQuery(connectionUri: string, sql: string): Promise<SimpleExecuteResult>;
  /**
   * Returns server metadata for the connection.
   */
  getServerInfo(connectionUri: string): Promise<IServerInfo>;
  /**
   * Lists available database names for the connection.
   */
  listDatabases(connectionUri: string): Promise<string[]>;
  /**
   * Closes the shared connection.
   */
  disconnect(connectionUri: string): Promise<void>;
}

/** Main MSSQL extension export */
export interface IExtension {
  /** Shows the native MSSQL connection picker dialog */
  promptForConnection(ignoreFocusOut?: boolean): Promise<IConnectionInfo | undefined>;
  /** Connect using IConnectionInfo, returns connectionUri */
  connect(connectionInfo: IConnectionInfo, saveConnection?: boolean): Promise<string>;
  /**
   * Lists available database names for the connection.
   */
  listDatabases(connectionUri: string): Promise<string[]>;
  /**
   * Returns server metadata for the connection info.
   */
  getServerInfo(connectionInfo: IConnectionInfo): IServerInfo;
  /** Connection-sharing sub-API (v1.34+) */
  connectionSharing: IConnectionSharingService;
}
