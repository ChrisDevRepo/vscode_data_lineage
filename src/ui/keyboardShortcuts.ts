/** Stable IDs for documented keyboard shortcuts. */
export type KeyboardShortcutId =
  | 'quickJump'
  | 'fitView'
  | 'openHelp'
  | 'excludeHighlightedNode'
  | 'exitMode'
  | 'toggleSchemaView'
  | 'hideExpandedSchemaClusters'
  | 'aiSectionPrevious'
  | 'aiSectionNext';

/**
 * Esc step-back order: one `useKeyboardShortcut` priority per overlay level, highest first. A lower
 * level never fires while a higher one is active and unblocked: Help outranks unpinning a column or
 * closing a local picker, which outrank exiting the mode. The mode-exit registration uses the
 * hook's default priority.
 */
export const ESC_PRIORITY = {
  help: 20,
  overlay: 10,
} as const;

/**
 * Subset of {@link KeyboardShortcutId} documented in the Help panel with a concrete binding in
 * {@link SHORTCUT_KEYS}. Each reaches the document, as an app-level shortcut or
 * (`aiSectionPrevious` / `aiSectionNext`) the AI report pane's focused handler.
 *
 * Binding {@link SHORTCUT_KEYS} to this id turns drift between the key map and the documented ids
 * into a compile error.
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
  | 'aiSectionPrevious'
  | 'aiSectionNext'
>;

/**
 * Display strings per shortcut. `useKeyboardShortcut` matches case-insensitively, so list each
 * letter key once, without upper/lowercase duplicates.
 */
export const SHORTCUT_KEYS: Record<AppShortcutId, string | string[]> = {
  quickJump: '/',
  fitView: 'f',
  openHelp: '?',
  excludeHighlightedNode: 'Delete',
  exitMode: 'Escape',
  toggleSchemaView: 's',
  hideExpandedSchemaClusters: 'h',
  aiSectionPrevious: '[',
  aiSectionNext: ']',
};

/**
 * Labels in the order the help panel and `docs/FEATURES.md` present them. Typed to
 * {@link AppShortcutId}, so a binding in {@link SHORTCUT_KEYS} without a description is a compile
 * error.
 */
export const SHORTCUT_DESCRIPTIONS: Record<AppShortcutId, string> = {
  quickJump: 'Focus Quick Jump',
  fitView: 'Fit the graph to the viewport',
  openHelp: 'Open Help',
  toggleSchemaView: 'Toggle Schema View',
  hideExpandedSchemaClusters: 'Hide schema clusters in Expanded Schema View',
  excludeHighlightedNode: 'Exclude the selected node from the view',
  exitMode: 'Close active input, then exit the current mode',
  aiSectionPrevious: 'Previous AI report section (report pane focused)',
  aiSectionNext: 'Next AI report section (report pane focused)',
};

/** A checkbox or radio is a choice, not a place the user is typing. */
function isChoiceInput(target: EventTarget): boolean {
  return target instanceof HTMLInputElement && (target.type === 'checkbox' || target.type === 'radio');
}

/**
 * True for a text-entry surface (`input`, `textarea`, `contenteditable`; not checkbox or radio).
 * The single guard for {@link useKeyboardShortcut} and the app-level handlers so bare-key shortcuts
 * never fire while typing; do not re-check element types inline.
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement) || isChoiceInput(target)) return false;
  return target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

/**
 * True for a text-entry surface that currently holds content. A step-back shortcut (Esc) uses it
 * instead of {@link isTextEntryTarget}: the first press clears the field (its own handler), and
 * only an empty field lets the shortcut step back out of the mode.
 */
export function isTextEntryTargetWithContent(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement) || isChoiceInput(target)) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return target.value.length > 0;
  return target.isContentEditable && (target.textContent?.length ?? 0) > 0;
}
