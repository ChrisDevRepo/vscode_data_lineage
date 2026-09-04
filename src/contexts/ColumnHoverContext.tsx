import { createContext, useContext, type ReactNode } from 'react';

/**
 * Active column thread of the column view, shared with the row renderers outside React Flow's
 * node data.
 *
 * @remarks
 * Hover deliberately does not travel in `ColumnTraceNodeData`: React Flow adopts a node whose
 * object identity changed, resets its handle bounds, and re-measures it. Rebuilding every node's
 * data on a pointer move therefore drives a measure/render loop rather than a highlight. The rows
 * read the hovered thread from here instead, so a hover re-renders rows and leaves the node objects
 * React Flow holds untouched.
 */
export interface ColumnHoverState {
  /**
   * Row keys from `columnRowKey` on the active thread; null while no thread is lit.
   *
   * @remarks
   * One field for both gestures. A pinned thread and a hovered one light the same rows, the same
   * edges and the same cards, so a second path would be a second source of truth for one visual —
   * the canvas resolves pin-over-hover and publishes the winner here.
   */
  hoveredPath: ReadonlySet<string> | null;
  /** Reports a row hover or focus enter with its column name, and a leave with `null`. */
  onColumnHover: (nodeId: string, column: string | null) => void;
  /** Reports a row click; the same row again clears the pin. */
  onColumnSelect: (nodeId: string, column: string) => void;
  /**
   * `columnRowKey` of the pinned row; null while the thread is only a hover preview.
   *
   * @remarks
   * Carried beside the path because a click at column level reads like a click at object level: the
   * clicked row's card takes the same yellow click-highlight the object view gives the clicked node,
   * and the path alone cannot say which of its rows was the one clicked.
   */
  pinnedRow: string | null;
}

const ColumnHoverContext = createContext<ColumnHoverState>({
  hoveredPath: null,
  onColumnHover: () => {},
  onColumnSelect: () => {},
  pinnedRow: null,
});

/**
 * Publishes the column-view thread to the node renderers below it.
 *
 * @param props - Component properties.
 * @param props.value - Current thread and the row hover/select reporters.
 * @param props.children - The nested React component tree, including the React Flow canvas.
 */
export const ColumnHoverProvider = ({ value, children }: { value: ColumnHoverState; children: ReactNode }) => (
  <ColumnHoverContext.Provider value={value}>{children}</ColumnHoverContext.Provider>
);

/**
 * Reads the column-view thread.
 *
 * @returns The active thread state; outside a provider, an empty thread and no-op reporters.
 */
export const useColumnHover = () => useContext(ColumnHoverContext);
