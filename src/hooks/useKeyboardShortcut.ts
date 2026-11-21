import { useEffect, useRef } from 'react';
import { isTextEntryTarget, isTextEntryTargetWithContent } from '../ui/keyboardShortcuts';

/** Tuning knobs for one {@link useKeyboardShortcut} registration. */
interface KeyboardShortcutOptions {
  /**
   * Higher runs first. When several active, unblocked registrations match a key (Esc closing a
   * picker vs. exiting the mode), only the highest-priority one fires. Default: `0`.
   */
  priority?: number;
  /**
   * Passes the text-entry guard when the focused input/textarea/contenteditable is empty, so a
   * step-back shortcut can exit the mode once the local field has nothing left to clear. Default:
   * `false` (any text-entry focus blocks).
   */
  allowEmptyTextEntry?: boolean;
  /** Registers the shortcut only while `true`; toggling adds or removes it. Default: `true`. */
  active?: boolean;
}

interface RegisteredShortcut {
  keys: string[];
  priority: number;
  preventDefault: boolean;
  isBlocked: (target: EventTarget | null) => boolean;
  invoke: () => void;
}

/**
 * Live shortcut registrations shared by every `useKeyboardShortcut` call. Competing handlers for
 * one key (an overlay's close vs. the mode-exit handler on Escape) resolve to one winner by
 * {@link KeyboardShortcutOptions.priority} instead of racing listeners with their own
 * `stopPropagation`.
 */
const registry = new Set<RegisteredShortcut>();

function dispatch(e: KeyboardEvent): void {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const key = e.key.toLowerCase();
  let winner: RegisteredShortcut | null = null;
  for (const entry of registry) {
    if (!entry.keys.includes(key)) continue;
    if (entry.isBlocked(e.target)) continue;
    if (!winner || entry.priority > winner.priority) winner = entry;
  }
  if (!winner) return;
  if (winner.preventDefault) e.preventDefault();
  winner.invoke();
}

let listenerCount = 0;

/** Attaches the single shared `keydown` listener on first use and detaches it on last release. */
function acquireListener(): () => void {
  if (listenerCount === 0) document.addEventListener('keydown', dispatch);
  listenerCount++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    listenerCount--;
    if (listenerCount === 0) document.removeEventListener('keydown', dispatch);
  };
}

/**
 * Registers global keyboard shortcuts in the VS Code webview.
 *
 * All registrations share one `document` `keydown` listener. Matching is case-insensitive and
 * ignores events with a Ctrl/Cmd/Alt modifier, so bare letters never collide with chords like
 * Ctrl+C. A match is blocked while a text-entry surface has focus; `allowEmptyTextEntry` relaxes
 * that to "while it holds content". Among active registrations matching a key, only the
 * highest-{@link KeyboardShortcutOptions.priority} unblocked one fires.
 *
 * @param key - Key or keys that trigger the callback, compared case-insensitively against
 *   `KeyboardEvent.key`.
 * @param callback - Runs when a matching key is pressed and this registration wins.
 * @param preventDefault - Call `e.preventDefault()` when this registration wins. Defaults to
 *   `false`.
 * @param options - Priority, the text-entry guard relaxation, and whether the registration is
 *   active.
 *
 * @example
 * ```tsx
 * useKeyboardShortcut('Escape', () => setIsOpen(false), true);
 * useKeyboardShortcut('Escape', unpinColumn, false, { priority: 10, active: !!pinnedColumn });
 * ```
 */
export function useKeyboardShortcut(
  key: string | string[],
  callback: () => void,
  preventDefault = false,
  options: KeyboardShortcutOptions = {},
): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  const { priority = 0, allowEmptyTextEntry = false, active = true } = options;
  const keysDep = Array.isArray(key) ? key.join('\0') : key;

  useEffect(() => {
    if (!active) return;
    const keys = (Array.isArray(key) ? key : [key]).map(k => k.toLowerCase());
    const entry: RegisteredShortcut = {
      keys,
      priority,
      preventDefault,
      isBlocked: (target) => (allowEmptyTextEntry ? isTextEntryTargetWithContent(target) : isTextEntryTarget(target)),
      invoke: () => callbackRef.current(),
    };
    registry.add(entry);
    const release = acquireListener();
    return () => {
      registry.delete(entry);
      release();
    };
  }, [keysDep, preventDefault, priority, allowEmptyTextEntry, active]);
}
