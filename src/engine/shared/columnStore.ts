/**
 * @module ColumnStore
 * Extension-host store for column metadata and DDL, kept off the webview model.
 */

import type { ColumnDef } from './types';

/** Column definitions and DDL by node id; built per model load and cleared on reload. */
export class ColumnStore {
  private readonly cols = new Map<string, ColumnDef[]>();

  private readonly ddl = new Map<string, string>();

  /** Stores the column definitions for `nodeId`. */
  setColumns(nodeId: string, columns: ColumnDef[]): void {
    this.cols.set(nodeId, columns);
  }

  /** Returns the stored column definitions for `nodeId`, if any. */
  getColumns(nodeId: string): ColumnDef[] | undefined {
    return this.cols.get(nodeId);
  }

  /** Stores the SQL body script for `nodeId`. */
  setDdl(nodeId: string, body: string): void {
    this.ddl.set(nodeId, body);
  }

  /** Returns the stored SQL body script for `nodeId`, if any. */
  getDdl(nodeId: string): string | undefined {
    return this.ddl.get(nodeId);
  }

  /** Clears all stored column definitions and DDL scripts. */
  clear(): void {
    this.cols.clear();
    this.ddl.clear();
  }
}
