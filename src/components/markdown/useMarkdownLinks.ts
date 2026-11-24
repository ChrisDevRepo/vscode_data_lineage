import type { KeyboardEvent, MouseEvent, SyntheticEvent } from 'react';
import { useVsCode } from '../../contexts/VsCodeContext';
import { FOCUS_NODE_HREF_PREFIX } from '../../engine/shared/bridgeContract';
import { errorMessage } from '../../utils/errorMessage';

/** Click and Space handlers for the links inside a `renderAiMarkdown` container. */
export interface MarkdownLinkHandlers {
  onClick: (e: MouseEvent<HTMLElement>) => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
}

/**
 * Link activation for rendered AI markdown: a link never navigates the webview. A
 * `#focus-node:<nodeId>` link calls `onFocusNode` (ignored when the view has no graph to focus), an
 * `http(s)` link goes to the host to open externally, and Space activates a focused link like a click.
 */
export function useMarkdownLinks(onFocusNode?: (nodeId: string) => void): MarkdownLinkHandlers {
  const vscodeApi = useVsCode();

  function focusNodeFromHref(href: string): (() => void) | null {
    if (!href.startsWith(FOCUS_NODE_HREF_PREFIX) || !onFocusNode) return null;
    const encoded = href.slice(FOCUS_NODE_HREF_PREFIX.length);
    let nodeId = encoded;
    try {
      nodeId = decodeURIComponent(encoded);
    } catch (err) {
      vscodeApi.postMessage({ type: 'log', level: 'debug', text: `[AI] focus link decode failed: ${encoded} (${errorMessage(err)})` });
    }
    return () => onFocusNode(nodeId);
  }

  function activate(e: SyntheticEvent<HTMLElement>): void {
    const href = (e.target as HTMLElement | null)?.closest('a')?.getAttribute('href');
    if (!href) return;
    e.preventDefault();
    const focus = focusNodeFromHref(href);
    if (focus) {
      focus();
      return;
    }
    if (/^https?:\/\//i.test(href)) {
      vscodeApi.postMessage({ type: 'open-external', url: href });
    }
  }

  return {
    onClick: activate,
    onKeyDown: (e) => { if (e.key === ' ') activate(e); },
  };
}
