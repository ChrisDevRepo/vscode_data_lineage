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
