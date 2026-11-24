import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useVsCode } from '../contexts/VsCodeContext';

/** `window.vscode` state keys the chat pane's width and open flag are kept under, beside other keys. */
const CHAT_WIDTH_STATE_KEY = 'chatDockWidth';
const CHAT_OPEN_STATE_KEY = 'chatDockOpen';
/** Width of the pane before the user resizes it; the stylesheet's `min-width` and `max-width` clamp it. */
const CHAT_DEFAULT_WIDTH = 440;
/** A resize drag is saved once the width has stopped changing for this long. */
const WIDTH_SETTLE_MS = 250;

// The chat is the largest dependency of the webview: its chunk loads when the pane is first opened.
const ChatPane = lazy(() => import('./chat/ChatPane'));

/**
 * The graph with the chat pane docked on its right edge. The pane is resizable like the AI report
 * column (native `resize: horizontal` plus a `ResizeObserver`), and its width and open state persist
 * in the webview state, which VS Code keeps per workspace panel. Once opened it stays mounted while
 * collapsed, so a running turn keeps streaming into it.
 */
export function ChatDock({ children }: { children: ReactNode }) {
  const vscodeApi = useVsCode();
  const paneId = useId();
  const saved = vscodeApi.getState();
  const [open, setOpen] = useState(() => saved?.[CHAT_OPEN_STATE_KEY] === true);
  const [everOpened, setEverOpened] = useState(open);
  const [width, setWidth] = useState(() => {
    const value = saved?.[CHAT_WIDTH_STATE_KEY];
    return typeof value === 'number' && value > 0 ? value : CHAT_DEFAULT_WIDTH;
  });
  const paneRef = useRef<HTMLElement | null>(null);

  const remember = useCallback((key: string, value: number | boolean) => {
    vscodeApi.setState({ ...(vscodeApi.getState() ?? {}), [key]: value });
  }, [vscodeApi]);

  const toggle = useCallback((next: boolean) => {
    setOpen(next);
    if (next) setEverOpened(true);
    remember(CHAT_OPEN_STATE_KEY, next);
  }, [remember]);

  useEffect(() => {
    const el = paneRef.current;
    if (!open || !el) return;
    let settle: number | undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const next = Math.round(entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width);
      if (next <= 0) return;
      setWidth(prev => (prev === next ? prev : next));
      window.clearTimeout(settle);
      settle = window.setTimeout(() => remember(CHAT_WIDTH_STATE_KEY, next), WIDTH_SETTLE_MS);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      window.clearTimeout(settle);
    };
  }, [open, everOpened, remember]);

  function handlePaneKeyDown(e: KeyboardEvent<HTMLElement>): void {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    toggle(false);
  }

  return (
    <div className="ln-chat-dock-host" style={{ paddingRight: open ? width : 0 }}>
      {children}
      <button
        className={open ? 'ln-chat-dock-close' : 'ln-chat-dock-rail'}
        onClick={() => toggle(!open)}
        aria-expanded={open}
        aria-controls={paneId}
        aria-label={open ? 'Collapse chat' : 'Open chat'}
      >
        {open ? '▶' : 'Chat'}
      </button>
      {everOpened && (
        <aside
          id={paneId}
          ref={paneRef}
          className="ln-chat-dock-pane"
          style={{ width, display: open ? undefined : 'none' }}
          aria-label="Chat"
          onKeyDown={handlePaneKeyDown}
        >
          <Suspense fallback={null}>
            <ChatPane />
          </Suspense>
        </aside>
      )}
    </div>
  );
}
