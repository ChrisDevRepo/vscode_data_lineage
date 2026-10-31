/**
 * Stable IDs of the documented shortcuts, each bound in {@link SHORTCUT_KEYS}. The `aiSection*` ids
 * are handled by the AI report pane itself while it has focus.
 */
export type AppShortcutId =
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
 * Esc step-back order, highest first: a lower level never fires while a higher one is active, so
 * Help outranks unpinning a column, which outranks exiting the mode (default priority).
 */
export const ESC_PRIORITY = {
  help: 20,
  overlay: 10,
} as const;

/** Key bindings of the documented shortcuts. */
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

/** Help-panel labels, in display order. */
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
  return (
    target instanceof HTMLInputElement &&
    (target.type === 'checkbox' || target.type === 'radio')
  );
}

/**
 * Reports whether an event target is a text-entry surface (`input`, `textarea`, or any
 * `contenteditable` element).
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement) || isChoiceInput(target)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement
  );
}

/** Reports whether an event target is a text-entry surface that currently holds content. */
export function isTextEntryTargetWithContent(
  target: EventTarget | null,
): boolean {
  if (!(target instanceof HTMLElement) || isChoiceInput(target)) return false;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement
  )
    return target.value.length > 0;
  return target.isContentEditable && (target.textContent?.length ?? 0) > 0;
}
