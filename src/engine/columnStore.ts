/**
 * @module ColumnStore
 * Provides extension-host-side storage for column metadata and DDL scripts.
 *
 * This store is designed to keep heavy metadata (columns and DDL) off the main webview model
 * to maintain performance. It serves as a just-in-time data source for:
 * - The Detail panel (fetching columns/DDL on click).
 * - AI reasoning tools (getObjectDetail, column tracing state machine).
 * - Advanced search features (DDL regex search).
 *
 * The store uses a two-level keyed lookup (Object ID -> Column Name) and maintains
 * a reverse index for efficient column-to-object discovery.
 */

import type { ColumnDef } from './types';

/**
 * Manages the lifecycle and retrieval of column definitions and DDL scripts.
 * Built once per model load and cleared on reload to prevent memory leaks.
 */
export class ColumnStore {
  /**
   * Primary storage mapping node unique identifiers to their ordered column definitions.
   * Preserves ordinal position from the source metadata.
   */
  private readonly cols = new Map<string, ColumnDef[]>();

  /**
   * Storage mapping node unique identifiers to their raw DDL (bodyScript) strings.
   */
  private readonly ddl = new Map<string, string>();

  /**
   * Reverse index mapping lowercase column names to a set of node identifiers containing them.
   * Enables O(1) discovery for column-level tracing.
   */
  private readonly nameIdx = new Map<string, Set<string>>();

  /**
   * Stores columns for a specific object and updates the reverse name index.
   *
   * @param nodeId - The unique identifier of the node (e.g., 'schema.object').
   * @param columns - Array of column definitions to persist.
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
   * Retrieves all ordered columns for a specific object.
   *
   * @param nodeId - The unique identifier of the node.
   * @returns An array of column definitions, or `undefined` if the node is not in the store.
   */
  getColumns(nodeId: string): ColumnDef[] | undefined {
    return this.cols.get(nodeId);
  }

  /**
   * Checks if an object has columns registered in the store.
   *
   * @param nodeId - The unique identifier of the node.
   * @returns `true` if columns exist; otherwise `false`.
   */
  hasColumns(nodeId: string): boolean {
    return this.cols.has(nodeId);
  }

  /**
   * Discovers all objects containing a specific column name using the reverse index.
   *
   * @param name - The column name to search for (case-insensitive).
   * @returns An array of node IDs that contain the specified column.
   */
  findByColumnName(name: string): string[] {
    return [...(this.nameIdx.get(name.toLowerCase()) ?? [])];
  }

  /**
   * Retrieves a specific column definition from an object.
   *
   * @param nodeId - The unique identifier of the node.
   * @param colName - The name of the column (case-insensitive).
   * @returns The matching column definition, or `undefined` if not found.
   */
  getColumn(nodeId: string, colName: string): ColumnDef | undefined {
    const lower = colName.toLowerCase();
    return this.cols.get(nodeId)?.find(c => c.name.toLowerCase() === lower);
  }

  /**
   * Retrieves only the names of all columns for a specific object in their original casing.
   * Useful for presenting valid options to the AI or user.
   *
   * @param nodeId - The unique identifier of the node.
   * @returns An array of column name strings.
   */
  getColumnNames(nodeId: string): string[] {
    return this.cols.get(nodeId)?.map(c => c.name) ?? [];
  }

  /**
   * Stores the raw DDL (bodyScript) for a specific object.
   *
   * @param nodeId - The unique identifier of the node.
   * @param body - The raw SQL DDL string.
   */
  setDdl(nodeId: string, body: string): void {
    this.ddl.set(nodeId, body);
  }

  /**
   * Retrieves the DDL script for a specific object.
   *
   * @param nodeId - The unique identifier of the node.
   * @returns The raw SQL DDL string, or `undefined` if not stored.
   */
  getDdl(nodeId: string): string | undefined {
    return this.ddl.get(nodeId);
  }

  /**
   * Checks if an object has a DDL script registered in the store.
   *
   * @param nodeId - The unique identifier of the node.
   * @returns `true` if DDL exists; otherwise `false`.
   */
  hasDdl(nodeId: string): boolean {
    return this.ddl.has(nodeId);
  }

  /**
   * Clears all internal maps to release memory.
   * Should be called during model reload or extension shutdown.
   */
  clear(): void {
    this.cols.clear();
    this.ddl.clear();
    this.nameIdx.clear();
  }

  /**
   * Returns sizing metrics for logging and memory diagnostics.
   *
   * @returns An object containing the number of objects, total columns, and DDL scripts stored.
   */
  get size(): { objects: number; totalColumns: number; ddlCount: number } {
    let totalColumns = 0;
    for (const cols of this.cols.values()) totalColumns += cols.length;
    return { objects: this.cols.size, totalColumns, ddlCount: this.ddl.size };
  }
}
