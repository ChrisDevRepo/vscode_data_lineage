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
  displayValue: string;
  isNull: boolean;
}

export interface IDbColumn {
  columnName: string;
  dataType: string;
  dataTypeName: string;
  allowDBNull?: boolean;
  columnOrdinal?: number;
}

export interface SimpleExecuteResult {
  rowCount: number;
  columnInfo: IDbColumn[];
  rows: DbCellValue[][];
}

export interface IServerInfo {
  serverMajorVersion: number;
  serverMinorVersion: number;
  serverVersion: string;
  engineEditionId: number;
  isCloud: boolean;
  serverEdition: string;
}

/** Connection info returned by promptForConnection() */
export interface IConnectionInfo {
  server: string;
  database: string;
  user: string;
  password: string;
  authenticationType: string;
  email?: string;
  accountId?: string;
  tenantId?: string;
  port: number;
  encrypt?: string | boolean;
  trustServerCertificate?: boolean;
  connectionString?: string;
}

/** Connection-Sharing API (v1.34+) — used for executeSimpleQuery */
export interface IConnectionSharingService {
  getActiveEditorConnectionId(extensionId: string): Promise<string | undefined>;
  connect(extensionId: string, connectionId: string, database?: string): Promise<string>;
  executeSimpleQuery(connectionUri: string, sql: string): Promise<SimpleExecuteResult>;
  getServerInfo(connectionUri: string): Promise<IServerInfo>;
  listDatabases(connectionUri: string): Promise<string[]>;
  disconnect(connectionUri: string): Promise<void>;
}

/** Main MSSQL extension export */
export interface IExtension {
  /** Shows the native MSSQL connection picker dialog */
  promptForConnection(ignoreFocusOut?: boolean): Promise<IConnectionInfo | undefined>;
  /** Connect using IConnectionInfo, returns connectionUri */
  connect(connectionInfo: IConnectionInfo, saveConnection?: boolean): Promise<string>;
  listDatabases(connectionUri: string): Promise<string[]>;
  getServerInfo(connectionInfo: IConnectionInfo): IServerInfo;
  /** Connection-sharing sub-API (v1.34+) */
  connectionSharing: IConnectionSharingService;
}
