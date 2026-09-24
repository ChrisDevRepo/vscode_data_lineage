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
  | 'aiSectionPrevious'
  | 'aiSectionNext';

/**
 * The Esc step-back order: one `useKeyboardShortcut` priority per overlay level, highest first.
 * A registration at a lower level never fires while a higher one is active and unblocked —
 * closing Help always outranks unpinning a column or closing a local picker, which always
 * outranks exiting the mode itself. The mode-exit registration uses the hook's default priority.
 */
export const ESC_PRIORITY = {
  help: 20,
  overlay: 10,
} as const;

/**
 * Subset of {@link KeyboardShortcutId} documented in the Help panel and carrying a concrete key
 * binding in {@link SHORTCUT_KEYS} — every one of them reaches the document, either as an
 * always-active app-level shortcut or, for `aiSectionPrevious` / `aiSectionNext`, as the AI
 * report pane's own local handler while it has focus.
 *
 * @remarks
 * Binding {@link SHORTCUT_KEYS} to `Record<AppShortcutId, string | string[]>` turns any drift
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
  | 'aiSectionPrevious'
  | 'aiSectionNext'
>;

/**
 * Display strings for the supported keyboard shortcuts.
 *
 * @remarks
 * `useKeyboardShortcut` matches case-insensitively — list each letter key once;
 * never add upper/lowercase duplicates.
 */
export const SHORTCUT_KEYS: Record<AppShortcutId, string | string[]> = {
  quickJump: '/',
  fitView: 'f',
  openHelp: '?',
  excludeHighlightedNode: ['Delete', 'Backspace'],
  exitMode: 'Escape',
  toggleSchemaView: 's',
  hideExpandedSchemaClusters: 'h',
  aiSectionPrevious: '[',
  aiSectionNext: ']',
};

/**
 * Display order and labels for the documented shortcuts, in the order the help
 * panel and `docs/FEATURES.md` present them.
 *
 * @remarks
 * Typing the entries to {@link AppShortcutId} keeps this list exhaustive: adding a
 * binding to {@link SHORTCUT_KEYS} without describing it here is a compile error, so
 * the help panel can never document fewer shortcuts than the app registers.
 */
export const SHORTCUT_DESCRIPTIONS: Record<AppShortcutId, string> = {
  quickJump: 'Focus Quick Jump',
  fitView: 'Fit the graph to the viewport',
  openHelp: 'Open Help',
  toggleSchemaView: 'Toggle Schema View',
  hideExpandedSchemaClusters: 'Hide schema clusters in Expanded Schema View',
  excludeHighlightedNode: 'Exclude the selected node from the view; in a trace, trim its branch',
  exitMode: 'Close active input, then exit the current mode',
  aiSectionPrevious: 'Previous AI report section (report pane focused)',
  aiSectionNext: 'Next AI report section (report pane focused)',
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

/**
 * Reports whether an event target is a text-entry surface that currently holds content.
 *
 * @remarks
 * A step-back shortcut (Esc) that owns emptying-then-exiting behavior passes this guard instead
 * of {@link isTextEntryTarget}: the first press clears the local field (handled by the field's own
 * key handler), and only once it is empty does the shortcut reach the mode it steps back out of.
 * A focused-but-empty field is not "the user is typing" for that purpose.
 *
 * @param target - The `KeyboardEvent.target` to classify.
 * @returns `true` when the target is a text-entry surface and currently non-empty.
 */
export function isTextEntryTargetWithContent(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return target.value.length > 0;
  return target.isContentEditable && (target.textContent?.length ?? 0) > 0;
}
