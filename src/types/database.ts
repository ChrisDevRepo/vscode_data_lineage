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

/** SQL Server metadata. */
export interface IServerInfo {
  /** SQL engine edition identifier (`SERVERPROPERTY('EngineEdition')`). */
  engineEditionId: number;
}
