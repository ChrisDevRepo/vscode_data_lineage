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

  // ─── Columns ────────────────────────────────────────────────────────────────

  /** Store columns for an object. Builds the reverse name index. */
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

  /** Get all columns for an object (ordered). */
  getColumns(nodeId: string): ColumnDef[] | undefined {
    return this.cols.get(nodeId);
  }

  /** Check if an object has columns stored. */
  hasColumns(nodeId: string): boolean {
    return this.cols.has(nodeId);
  }

  /** Find all objects containing a column name — O(1) via reverse index. */
  findByColumnName(name: string): string[] {
    return [...(this.nameIdx.get(name.toLowerCase()) ?? [])];
  }

  /** Get a specific column on a specific object (case-insensitive). */
  getColumn(nodeId: string, colName: string): ColumnDef | undefined {
    const lower = colName.toLowerCase();
    return this.cols.get(nodeId)?.find(c => c.name.toLowerCase() === lower);
  }

  /** All column names on an object (original casing). For reject/retry valid list. */
  getColumnNames(nodeId: string): string[] {
    return this.cols.get(nodeId)?.map(c => c.name) ?? [];
  }

  // ─── DDL ────────────────────────────────────────────────────────────────────

  /** Store DDL (bodyScript) for an object. */
  setDdl(nodeId: string, body: string): void {
    this.ddl.set(nodeId, body);
  }

  /** Get DDL for an object. */
  getDdl(nodeId: string): string | undefined {
    return this.ddl.get(nodeId);
  }

  /** Check if an object has DDL stored. */
  hasDdl(nodeId: string): boolean {
    return this.ddl.has(nodeId);
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  /** Clear all data (called on model reload). */
  clear(): void {
    this.cols.clear();
    this.ddl.clear();
    this.nameIdx.clear();
  }

  /** Stats for logging. */
  get size(): { objects: number; totalColumns: number; ddlCount: number } {
    let totalColumns = 0;
    for (const cols of this.cols.values()) totalColumns += cols.length;
    return { objects: this.cols.size, totalColumns, ddlCount: this.ddl.size };
  }
}
