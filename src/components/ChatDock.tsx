import {
  lazy, Suspense, useCallback, useEffect, useId, useState,
  type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode,
} from 'react';
import { useVsCode } from '../contexts/VsCodeContext';

/** `window.vscode` state keys holding the chat pane's width and open flag, beside other keys. */
const CHAT_WIDTH_STATE_KEY = 'chatDockWidth';
const CHAT_OPEN_STATE_KEY = 'chatDockOpen';
/** Width of the pane before the user resizes it. */
const CHAT_DEFAULT_WIDTH = 440;
/** The pane stays at least this wide (px) and at most this share of the window (percent). */
const CHAT_MIN_WIDTH = 280;
const CHAT_MAX_WIDTH_VW = 75;
/** Px an arrow key moves the pane's left edge. */
const CHAT_KEY_STEP = 24;

/** The widest the pane may be in this window (px, never below the minimum). */
const maxWidth = (): number =>
  Math.max(Math.round((window.innerWidth * CHAT_MAX_WIDTH_VW) / 100), CHAT_MIN_WIDTH);
/** A width a drag or key writes: whole px between the minimum and the maximum. */
const clampWidth = (px: number): number => Math.min(Math.max(Math.round(px), CHAT_MIN_WIDTH), maxWidth());

// The chat is the largest dependency of the webview: its chunk loads when the pane is first opened.
const ChatPane = lazy(() => import('./chat/ChatPane'));

/**
 * The graph with the chat pane docked on its right edge. A handle on the pane's left edge widens
 * and narrows it (pointer drag or arrow keys; the pane sits on the window's right edge, so the
 * native `resize` grip could only shrink it), and its width and open state persist in the webview
 * state, which VS Code keeps per workspace panel. The width is one CSS variable; the stylesheet
 * turns it into the rail the graph column leaves free and the pane fills (`--ln-chat-rail`). Once
 * opened the pane stays mounted while collapsed, so a running turn keeps streaming into it. When
 * the host says the chat is off (`dataLineageViz.ai.enabled`), only the graph renders.
 */
export function ChatDock({ children }: { children: ReactNode }) {
  return window.AI_CHAT_ENABLED === true ? <DockedChat>{children}</DockedChat> : <>{children}</>;
}

function DockedChat({ children }: { children: ReactNode }) {
  const vscodeApi = useVsCode();
  const paneId = useId();
  const saved = vscodeApi.getState();
  const [open, setOpen] = useState(() => saved?.[CHAT_OPEN_STATE_KEY] === true);
  const [everOpened, setEverOpened] = useState(open);
  const [width, setWidth] = useState(() => {
    const value = saved?.[CHAT_WIDTH_STATE_KEY];
    return typeof value === 'number' && value > 0 ? value : CHAT_DEFAULT_WIDTH;
  });
  const remember = useCallback((key: string, value: number | boolean) => {
    vscodeApi.setState({ ...(vscodeApi.getState() ?? {}), [key]: value });
  }, [vscodeApi]);

  const toggle = useCallback((next: boolean) => {
    setOpen(next);
    if (next) setEverOpened(true);
    remember(CHAT_OPEN_STATE_KEY, next);
  }, [remember]);

  const [drag, setDrag] = useState<{ startX: number; startWidth: number } | null>(null);

  const resize = useCallback((next: number) => {
    const clamped = clampWidth(next);
    setWidth(clamped);
    return clamped;
  }, []);

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: globalThis.PointerEvent) => { resize(drag.startWidth + drag.startX - e.clientX); };
    const onEnd = (e: globalThis.PointerEvent) => {
      remember(CHAT_WIDTH_STATE_KEY, resize(drag.startWidth + drag.startX - e.clientX));
      setDrag(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
    };
  }, [drag, remember, resize]);

  function handleHandlePointerDown(e: PointerEvent<HTMLElement>): void {
    if (e.button !== 0) return;
    e.preventDefault();
    setDrag({ startX: e.clientX, startWidth: clampWidth(width) });
  }

  function handleHandleKeyDown(e: KeyboardEvent<HTMLElement>): void {
    const delta = e.key === 'ArrowLeft' ? CHAT_KEY_STEP : e.key === 'ArrowRight' ? -CHAT_KEY_STEP : 0;
    if (delta === 0) return;
    e.preventDefault();
    remember(CHAT_WIDTH_STATE_KEY, resize(clampWidth(width) + delta));
  }

  function handlePaneKeyDown(e: KeyboardEvent<HTMLElement>): void {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    toggle(false);
  }

  const railVars = {
    '--ln-chat-width': `${width}px`,
    '--ln-chat-min': `${CHAT_MIN_WIDTH}px`,
    '--ln-chat-max': `${CHAT_MAX_WIDTH_VW}vw`,
  } as CSSProperties;

  return (
    <div
      className="ln-chat-dock-host"
      data-open={open ? '' : undefined}
      data-resizing={drag ? '' : undefined}
      style={railVars}
    >
      <div className="ln-chat-dock-main">{children}</div>
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
          className="ln-chat-dock-pane"
          style={{ display: open ? undefined : 'none' }}
          aria-label="Chat"
          onKeyDown={handlePaneKeyDown}
        >
          <div
            className="ln-chat-dock-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize chat"
            aria-valuenow={clampWidth(width)}
            aria-valuemin={CHAT_MIN_WIDTH}
            aria-valuemax={maxWidth()}
            tabIndex={0}
            onPointerDown={handleHandlePointerDown}
            onKeyDown={handleHandleKeyDown}
          />
          <Suspense fallback={null}>
            <ChatPane />
          </Suspense>
        </aside>
      )}
    </div>
  );
}
