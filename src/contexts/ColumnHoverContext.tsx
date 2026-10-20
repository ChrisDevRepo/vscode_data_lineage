import { createContext, useContext, type ReactNode } from 'react';

/** Active column thread of the column view, shared with the row renderers outside React Flow's node data. */
export interface ColumnHoverState {
  /** Row keys from `columnRowKey` on the active thread; null while no thread is lit. */
  hoveredPath: ReadonlySet<string> | null;
  /** Reports a row hover or focus enter with its column name, and a leave with `null`. */
  onColumnHover: (nodeId: string, column: string | null) => void;
  /** Reports a row click; the same row again clears the pin. */
  onColumnSelect: (nodeId: string, column: string) => void;
  /** `columnRowKey` of the pinned row; null while the thread is only a hover preview. */
  pinnedRow: string | null;
}

const ColumnHoverContext = createContext<ColumnHoverState>({
  hoveredPath: null,
  onColumnHover: () => {},
  onColumnSelect: () => {},
  pinnedRow: null,
});

/** Publishes the column-view thread to the node renderers below it. */
export const ColumnHoverProvider = ({ value, children }: { value: ColumnHoverState; children: ReactNode }) => (
  <ColumnHoverContext.Provider value={value}>{children}</ColumnHoverContext.Provider>
);

/** Reads the column-view thread. */
export const useColumnHover = () => useContext(ColumnHoverContext);
