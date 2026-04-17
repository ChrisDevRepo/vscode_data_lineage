/**
 * ColumnStore — extension-host-side storage for column metadata and DDL.
 *
 * Keeps columns and DDL OFF the webview model, loaded on-demand for:
 *  - Detail panel (click → columns/DDL)
 *  - AI tools (getObjectDetail, column-trace state machine)
 *  - Detail search sidebar (column name + DDL regex search)
 *
 * Two-level keyed lookup: object ID → column name → full ColumnDef metadata.
 * Reverse index for O(1) column-name lookups (column-trace auto-discover).
 *
 * Built once per model load in modelBuilder. Cleared on model reload.
 */

import type { ColumnDef } from './types';

export class ColumnStore {
  /** Primary: nodeId → ordered columns (preserves ordinal). */
  private readonly cols = new Map<string, ColumnDef[]>();

  /** DDL: nodeId → bodyScript string. */
  private readonly ddl = new Map<string, string>();

  /** Reverse: lowercase column name → set of nodeIds containing it. */
  private readonly nameIdx = new Map<string, Set<string>>();

  /**
   * Store columns for an object. Builds the reverse name index.
   *
   * @param nodeId - The unique identifier of the node (schema.object).
   * @param columns - Array of column definitions to store.
   */
  setColumns(nodeId: string, columns: ColumnDef[]): void {
    this.cols.set(nodeId, columns);
    for (const c of columns) {
      const key = c.name.toLowerCase();
      let set = this.nameIdx.get(key);
      if (!set) {
        set = new Set();
        this.nameIdx.set(key, set);
      }
      set.add(nodeId);
    }
  }

  /**
   * Get all columns for an object (ordered).
   *
   * @param nodeId - The unique identifier of the node.
   * @returns Array of column definitions, or undefined if not found.
   */
  getColumns(nodeId: string): ColumnDef[] | undefined {
    return this.cols.get(nodeId);
  }

  /**
   * Check if an object has columns stored.
   *
   * @param nodeId - The unique identifier of the node.
   * @returns True if columns exist for the node.
   */
  hasColumns(nodeId: string): boolean {
    return this.cols.has(nodeId);
  }

  /**
   * Find all objects containing a column name — O(1) via reverse index.
   *
   * @param name - The column name to search for.
   * @returns Array of node IDs that contain the column.
   */
  findByColumnName(name: string): string[] {
    return [...(this.nameIdx.get(name.toLowerCase()) ?? [])];
  }

  /**
   * Get a specific column on a specific object (case-insensitive).
   *
   * @param nodeId - The unique identifier of the node.
   * @param colName - The name of the column.
   * @returns The column definition, or undefined if not found.
   */
  getColumn(nodeId: string, colName: string): ColumnDef | undefined {
    const lower = colName.toLowerCase();
    return this.cols.get(nodeId)?.find(c => c.name.toLowerCase() === lower);
  }

  /**
   * All column names on an object (original casing).
   * Useful for reject/retry valid lists.
   *
   * @param nodeId - The unique identifier of the node.
   * @returns Array of column names.
   */
  getColumnNames(nodeId: string): string[] {
    return this.cols.get(nodeId)?.map(c => c.name) ?? [];
  }

  /**
   * Store DDL (bodyScript) for an object.
   *
   * @param nodeId - The unique identifier of the node.
   * @param body - The raw DDL string.
   */
  setDdl(nodeId: string, body: string): void {
    this.ddl.set(nodeId, body);
  }

  /**
   * Get DDL for an object.
   *
   * @param nodeId - The unique identifier of the node.
   * @returns The DDL string, or undefined if not found.
   */
  getDdl(nodeId: string): string | undefined {
    return this.ddl.get(nodeId);
  }

  /**
   * Check if an object has DDL stored.
   *
   * @param nodeId - The unique identifier of the node.
   * @returns True if DDL exists for the node.
   */
  hasDdl(nodeId: string): boolean {
    return this.ddl.has(nodeId);
  }

  /**
   * Clear all data. Called on model reload to release memory.
   */
  clear(): void {
    this.cols.clear();
    this.ddl.clear();
    this.nameIdx.clear();
  }

  /**
   * Stats for logging and diagnostic purposes.
   *
   * @returns Object containing sizing metrics.
   */
  get size(): { objects: number; totalColumns: number; ddlCount: number } {
    let totalColumns = 0;
    for (const cols of this.cols.values()) totalColumns += cols.length;
    return { objects: this.cols.size, totalColumns, ddlCount: this.ddl.size };
  }
}
