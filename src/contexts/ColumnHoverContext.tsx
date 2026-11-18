import { createContext, useContext, type ReactNode } from 'react';

/**
 * Active column thread of the column view, shared with the row renderers outside React Flow's node
 * data. Hover does not travel in `ColumnTraceNodeData`: React Flow re-measures a node whose object
 * identity changed, so rebuilding every node's data on a pointer move drives a measure/render loop.
 * Rows read the hovered thread from here, leaving the node objects untouched.
 */
export interface ColumnHoverState {
  /**
   * Row keys from `columnRowKey` on the active thread; null while none is lit. One field for both
   * gestures: a pinned and a hovered thread light the same rows, edges and cards, so the canvas
   * resolves pin-over-hover and publishes the winner here.
   */
  hoveredPath: ReadonlySet<string> | null;
  /** Reports a row hover or focus enter with its column name, and a leave with `null`. */
  onColumnHover: (nodeId: string, column: string | null) => void;
  /** Reports a row click; the same row again clears the pin. */
  onColumnSelect: (nodeId: string, column: string) => void;
  /**
   * `columnRowKey` of the pinned row; null while the thread is only a hover preview. Carried beside
   * the path because a column-level click gives the clicked row's card the object view's yellow
   * click-highlight, and the path cannot say which row was clicked.
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
 * @param props.value - Current thread and the row hover/select reporters.
 * @param props.children - The nested tree, including the React Flow canvas.
 */
export const ColumnHoverProvider = ({ value, children }: { value: ColumnHoverState; children: ReactNode }) => (
  <ColumnHoverContext.Provider value={value}>{children}</ColumnHoverContext.Provider>
);

/** Reads the column-view thread; outside a provider, an empty thread and no-op reporters. */
export const useColumnHover = () => useContext(ColumnHoverContext);
