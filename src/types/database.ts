/**
 * Result and metadata shapes shared by the database session and the DMV consumers.
 *
 * The built-in connection produces them; the field names follow the form the retired SQL Server
 * (mssql) extension API returned, which the DMV consumers read.
 */

export interface DbCellValue {
  /**
   * Formatted cell value.
   */
  displayValue: string;
  /**
   * Whether the cell value is `NULL`.
   */
  isNull: boolean;
}

/**
 * Column metadata of a query result.
 */
export interface IDbColumn {
  columnName: string;
  /**
   * Database-specific type identifier.
   */
  dataType: string;
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
 * Query result of one SQL batch.
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
 * Server version and edition metadata.
 */
export interface IServerInfo {
  serverMajorVersion: number;
  serverMinorVersion: number;
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
