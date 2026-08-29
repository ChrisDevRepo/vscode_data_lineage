import { createContext, useContext, type ReactNode } from 'react';

/**
 * Hover state of the column view, shared with the row renderers outside React Flow's node data.
 *
 * @remarks
 * Hover deliberately does not travel in `ColumnTraceNodeData`: React Flow adopts a node whose
 * object identity changed, resets its handle bounds, and re-measures it. Rebuilding every node's
 * data on a pointer move therefore drives a measure/render loop rather than a highlight. The rows
 * read the hovered thread from here instead, so a hover re-renders rows and leaves the node objects
 * React Flow holds untouched.
 */
export interface ColumnHoverState {
  /** Row keys from `columnRowKey` on the hovered thread; null while no row is hovered. */
  hoveredPath: ReadonlySet<string> | null;
  /** Reports a row hover or focus enter with its column name, and a leave with `null`. */
  onColumnHover: (nodeId: string, column: string | null) => void;
}

const ColumnHoverContext = createContext<ColumnHoverState>({
  hoveredPath: null,
  onColumnHover: () => {},
});

/**
 * Publishes the column-view hover thread to the node renderers below it.
 *
 * @param props - Component properties.
 * @param props.value - Current hover thread and the row hover reporter.
 * @param props.children - The nested React component tree, including the React Flow canvas.
 */
export const ColumnHoverProvider = ({ value, children }: { value: ColumnHoverState; children: ReactNode }) => (
  <ColumnHoverContext.Provider value={value}>{children}</ColumnHoverContext.Provider>
);

/**
 * Reads the column-view hover thread.
 *
 * @returns The active hover state; outside a provider, an empty thread and a no-op reporter.
 */
export const useColumnHover = () => useContext(ColumnHoverContext);
