/**
 * The one reading of an object's detail facts, shared by the GUI detail panel and the AI tools.
 *
 * @remarks
 * A presenter only formats: the panel ships the facts raw, `lineage_get_object_detail` abbreviates
 * columns and foreign keys and normalises the DDL. Neighbours are not projected here; they are the
 * model's `neighborIndex`, which both surfaces already read directly.
 */
import type { ColumnDef, ForeignKeyInfo, LineageNode } from './types';

/**
 * The two high-fidelity reads taken from the engine's column store.
 *
 * @remarks
 * Declared structurally so callers state what they read instead of importing the store
 * implementation; `ColumnStore` satisfies it as written.
 */
export interface NodeSnapshotStore {
  /** Stored column definitions for `nodeId`, or `undefined` when the store holds none. */
  getColumns(nodeId: string): ColumnDef[] | undefined;
  /** Stored DDL text for `nodeId`, or `undefined` when the store holds none. */
  getDdl(nodeId: string): string | undefined;
}

/** What the model holds about one object; an absent fact is `undefined`. */
export interface ObjectDetail {
  columns: ColumnDef[] | undefined;
  /** The DDL exactly as stored; a presenter normalises it. */
  ddl: string | undefined;
  foreignKeys: ForeignKeyInfo[] | undefined;
}

/** Projects an object to its columns and DDL (the store first, then the node) and foreign keys. */
export function projectObject(
  node: Pick<LineageNode, 'id' | 'columns' | 'bodyScript' | 'fks'>,
  store?: NodeSnapshotStore,
): ObjectDetail {
  return {
    columns: store?.getColumns(node.id) ?? node.columns,
    ddl: store?.getDdl(node.id) ?? node.bodyScript,
    foreignKeys: node.fks,
  };
}
