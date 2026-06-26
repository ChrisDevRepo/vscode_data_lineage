/**
 * Stable IDs for documented keyboard shortcuts.
 */
export type KeyboardShortcutId =
  | 'quickJump'
  | 'fitView'
  | 'openHelp'
  | 'excludeHighlightedNode'
  | 'exitMode'
  | 'toggleSchemaView'
  | 'hideExpandedSchemaClusters'
  | 'suggestionNavigation'
  | 'selectSuggestion'
  | 'closeInput'
  | 'activateFocusedControl'
  | 'expandSchemaCluster';

/**
 * Subset of {@link KeyboardShortcutId} for app-level (always-active) shortcuts —
 * the ids that carry a concrete key binding in {@link SHORTCUT_KEYS}.
 *
 * @remarks
 * Binding {@link SHORTCUT_KEYS} to `Record<AppShortcutId, string>` turns any drift
 * between the runtime key map and the documented ids into a compile error.
 */
export type AppShortcutId = Extract<
  KeyboardShortcutId,
  | 'quickJump'
  | 'fitView'
  | 'openHelp'
  | 'excludeHighlightedNode'
  | 'exitMode'
  | 'toggleSchemaView'
  | 'hideExpandedSchemaClusters'
>;

/**
 * Display metadata for a documented keyboard shortcut.
 */
export interface KeyboardShortcutDoc {
  /** Stable registry key used by tests and help/documentation alignment checks. */
  id: KeyboardShortcutId;
  /** Human-readable key labels rendered in help and docs. */
  keys: string[];
  /** User-facing action label for the shortcut. */
  label: string;
}

/**
 * Display strings for the supported keyboard shortcuts.
 *
 * @remarks
 * `useKeyboardShortcut` matches case-insensitively — list each letter key once;
 * never add upper/lowercase duplicates.
 */
export const SHORTCUT_KEYS: Record<AppShortcutId, string> = {
  quickJump: '/',
  fitView: 'f',
  openHelp: '?',
  excludeHighlightedNode: 'Delete',
  exitMode: 'Escape',
  toggleSchemaView: 's',
  hideExpandedSchemaClusters: 'h',
};

/**
 * Keyboard shortcuts that apply across the whole app.
 */
export const APP_LEVEL_SHORTCUTS: KeyboardShortcutDoc[] = [
  { id: 'quickJump', keys: ['/'], label: 'Focus Quick Jump' },
  { id: 'fitView', keys: ['F'], label: 'Fit graph to view' },
  { id: 'openHelp', keys: ['?'], label: 'Open Help' },
  { id: 'excludeHighlightedNode', keys: ['Delete'], label: 'Exclude highlighted node' },
  { id: 'exitMode', keys: ['Esc'], label: 'Exit active trace, path, analysis, bookmark, or AI preview' },
  { id: 'toggleSchemaView', keys: ['S'], label: 'Toggle Schema View' },
  { id: 'hideExpandedSchemaClusters', keys: ['H'], label: 'Hide/Show schema clusters' },
];

/**
 * Keyboard shortcuts that depend on the active UI context.
 */
export const CONTEXTUAL_SHORTCUTS: KeyboardShortcutDoc[] = [
  { id: 'suggestionNavigation', keys: ['↑', '↓'], label: 'Move through Quick Jump and path suggestions' },
  { id: 'selectSuggestion', keys: ['Enter'], label: 'Select a suggestion or apply the current input action' },
  { id: 'closeInput', keys: ['Esc'], label: 'Close the active input or dropdown before broader mode exit' },
  { id: 'activateFocusedControl', keys: ['Enter', 'Space'], label: 'Activate focused graph, sidebar, and list controls' },
  { id: 'expandSchemaCluster', keys: ['Enter', 'Space'], label: 'Expand a focused schema cluster' },
];

/**
 * Reports whether an event target is a text-entry surface (`input`, `textarea`,
 * or any `contenteditable` element).
 *
 * @remarks
 * Shared by {@link useKeyboardShortcut} and the app-level shortcut handlers so
 * bare-key shortcuts never fire while the user is typing. Single source of truth
 * for the guard — keep both consumers on this function rather than re-checking
 * element types inline.
 *
 * @param target - The `KeyboardEvent.target` to classify.
 * @returns `true` when the target accepts text input and shortcuts must be suppressed.
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement
  );
}
