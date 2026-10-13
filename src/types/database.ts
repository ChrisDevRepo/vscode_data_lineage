/** Formatted database result cell. */
export interface DbCellValue {
  /**
   * Formatted cell value returned by the database.
   */
  displayValue: string;
  /**
   * Whether the cell value is `NULL`.
   */
  isNull: boolean;
}

/**
 * Database result column metadata.
 */
export interface IDbColumn {
  /**
   * Column name reported by the database.
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
 * Database query results.
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
 * SQL Server metadata.
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
