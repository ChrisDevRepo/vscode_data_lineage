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
 * Stores ordered column arrays by node ID.
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
   * Stores columns for a specific object.
   *
   * @param nodeId - The unique identifier of the node (e.g., 'schema.object').
   * @param columns - Array of column definitions to persist.
   */
  setColumns(nodeId: string, columns: ColumnDef[]): void {
    this.cols.set(nodeId, columns);
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
   * Clears all internal maps to release memory.
   * Should be called during model reload or extension shutdown.
   */
  clear(): void {
    this.cols.clear();
    this.ddl.clear();
  }
}
