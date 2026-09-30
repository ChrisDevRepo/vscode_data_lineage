import { useEffect, useRef } from 'react';
import { isTextEntryTarget, isTextEntryTargetWithContent } from '../ui/keyboardShortcuts';

/** Tuning knobs for one {@link useKeyboardShortcut} registration. */
interface KeyboardShortcutOptions {
  /**
   * Higher runs first. When more than one active, unblocked registration matches the same key
   * (Esc closing a picker vs. exiting the whole mode, for instance), only the highest-priority
   * one fires — the rest are not called. Default: `0`.
   */
  priority?: number;
  /**
   * Passes the text-entry guard when the focused input/textarea/contenteditable is empty, so a
   * step-back shortcut can still exit the surrounding mode once the local field it would
   * otherwise be blocked by has nothing left to clear. Default: `false` (any text-entry focus blocks).
   */
  allowEmptyTextEntry?: boolean;
  /** Registers the shortcut only while `true`; toggling it adds/removes the registration. Default: `true`. */
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
 * Live shortcut registrations, shared across every `useKeyboardShortcut` call.
 *
 * @remarks
 * Competing handlers for the same key — an overlay's local close vs. the app's mode-exit handler
 * both bound to Escape — resolve to exactly one winner by {@link KeyboardShortcutOptions.priority}
 * instead of racing independent listeners with their own `stopPropagation`.
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
 * Custom hook for registering global keyboard shortcuts within the VS Code webview context.
 *
 * @remarks
 * Every registration shares one `document` `keydown` listener. Matching is case-insensitive and
 * ignores events carrying a Ctrl/Cmd/Alt modifier, so bare-letter shortcuts never collide with
 * native chords like Ctrl+C. By default a match is blocked while a text-entry surface (`input`,
 * `textarea`, or any `contenteditable` element) has focus; pass `allowEmptyTextEntry` to relax
 * that to "blocked only while that surface holds content". When two or more active registrations
 * match the same key, only the highest-{@link KeyboardShortcutOptions.priority} unblocked one
 * fires.
 *
 * @param key - The key or array of keys that should trigger the callback. Compared case-insensitively against `KeyboardEvent.key`.
 * @param callback - The function to execute when a matching key is pressed and this registration wins.
 * @param preventDefault - Whether to call `e.preventDefault()` when this registration wins. Defaults to `false`.
 * @param options - Priority, the text-entry guard relaxation, and whether the registration is currently active.
 *
 * @example
 * ```tsx
 * useKeyboardShortcut('Escape', () => setIsOpen(false), true);
 * useKeyboardShortcut(['Enter', 'n'], () => handleCreate(), false);
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
