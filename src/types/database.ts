/** Formatted database result cell. */
export interface DbCellValue {
  displayValue: string;
  isNull: boolean;
}

/** Database result column metadata. */
export interface IDbColumn {
  columnName: string;
}

/** Database query results. */
export interface SimpleExecuteResult {
  rowCount: number;
  columnInfo: IDbColumn[];
  rows: DbCellValue[][];
}

/** SQL Server metadata. */
export interface IServerInfo {
  /** SQL engine edition identifier (`SERVERPROPERTY('EngineEdition')`). */
  engineEditionId: number;
}
