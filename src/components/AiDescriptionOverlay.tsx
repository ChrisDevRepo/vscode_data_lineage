import React, { memo, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { Tooltip } from './ui/Tooltip';
import { preprocessDescriptionMarkdown } from './aiDescriptionMarkdown';

/**
 * Props for the `AiDescriptionOverlay` component.
 */
interface AiDescriptionOverlayProps {
  /** The name of the AI-generated view or analysis. */
  viewName: string;
  /** The markdown-formatted description text to display. */
  description: string;
  /** Whether the overlay should be expanded by default on initial render. */
  defaultExpanded?: boolean;
  /** Called when a `#focus-node:<nodeId>` link is clicked — zooms the graph to that node. */
  onFocusNode?: (nodeId: string) => void;
}

/**
 * A floating overlay component that displays AI-generated descriptions and logic summaries.
 *
 * @remarks
 * Renders markdown with GitHub Flavored Markdown (GFM) and KaTeX math via
 * `remark-math` + `rehype-katex`, supporting inline `$...$`, block `$$...$$`,
 * and fenced ` ```math ` formulas. Raw source and clipboard copy are also available.
 *
 * @param props - The component props.
 */
export const AiDescriptionOverlay = memo(function AiDescriptionOverlay({
  viewName,
  description,
  defaultExpanded = false,
  onFocusNode,
}: AiDescriptionOverlayProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [rawMode, setRawMode] = useState(false);
  const [copied, setCopied] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [fontScale, setFontScale] = useState<0 | 1 | 2>(0);

  function AnchorComponent({ href, children, ...props }: React.HTMLAttributes<HTMLAnchorElement> & { href?: string }) {
    if (href?.startsWith('#focus-node:') && onFocusNode) {
      return (
        <a
          href={href}
          {...props}
          role="button"
          tabIndex={0}
          onClick={(e) => { e.preventDefault(); onFocusNode(decodeURIComponent(href.slice('#focus-node:'.length))); }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onFocusNode(decodeURIComponent(href.slice('#focus-node:'.length))); } }}
        >
          {children}
        </a>
      );
    }
    return <a href={href} {...props}>{children}</a>;
  }

  function H3Component({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
    const arr = React.Children.toArray(children);
    const first = arr[0];
    if (typeof first === 'string' && first.startsWith('Objects ')) {
      return (
        <h3 {...props}>
          <span className="ln-ai-objects-label">Objects</span>
          {first.slice('Objects '.length)}
          {arr.slice(1)}
        </h3>
      );
    }
    return <h3 {...props}>{children}</h3>;
  }

  /**
   * Copies the raw markdown description to the system clipboard.
   */
  function handleCopy() {
    navigator.clipboard.writeText(description).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(err => window.vscode?.postMessage({ type: 'error', error: `Clipboard write failed: ${err instanceof Error ? err.message : String(err)}` }));
  }

  const processedDescription = preprocessDescriptionMarkdown(description);
  const overlayClassName = [
    'ln-ai-description-overlay',
    maximized ? 'ln-ai-description-overlay-maximized' : '',
    `ln-ai-description-font-${fontScale}`,
  ].filter(Boolean).join(' ');
  const anchorClassName = [
    'ln-ai-description-anchor',
    maximized ? 'ln-ai-description-anchor-maximized' : '',
  ].filter(Boolean).join(' ');

  function handleCollapse() {
    setMaximized(false);
    setExpanded(false);
  }

  return (
    <div className={anchorClassName}>
      {!expanded ? (
        <button
          className="ln-ai-description-bar"
          onClick={() => setExpanded(true)}
          aria-expanded={false}
          aria-label="Expand description"
        >
          <span className="ln-ai-description-bar-name">{viewName}</span>
          <span className="ln-ai-description-bar-toggle">Description &#x25BC;</span>
        </button>
      ) : (
        <div className={overlayClassName}>
          <div className="ln-ai-description-header">
            <span className="ln-ai-description-title text-[10px] font-semibold ln-text-muted uppercase tracking-wide">
              {viewName}
            </span>
            <div className="ln-ai-description-actions">
              <Tooltip content="Decrease text size">
                <button
                  className="ln-ai-description-action ln-ai-description-text-action"
                  onClick={() => setFontScale(v => (v > 0 ? (v - 1) as 0 | 1 : v))}
                  aria-label="Decrease description text size"
                  disabled={fontScale === 0}
                >
                  A-
                </button>
              </Tooltip>
              <Tooltip content="Increase text size">
                <button
                  className="ln-ai-description-action ln-ai-description-text-action"
                  onClick={() => setFontScale(v => (v < 2 ? (v + 1) as 1 | 2 : v))}
                  aria-label="Increase description text size"
                  disabled={fontScale === 2}
                >
                  A+
                </button>
              </Tooltip>
              <Tooltip content={maximized ? 'Restore original size' : 'Maximize description'}>
                <button
                  className="ln-ai-description-action"
                  onClick={() => setMaximized(v => !v)}
                  aria-label={maximized ? 'Restore original description size' : 'Maximize description'}
                >
                  {maximized ? (
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M6.75 1a.75.75 0 0 1 .75.75v5a.75.75 0 0 1-.75.75h-5a.75.75 0 0 1 0-1.5h3.19L.72 1.78A.75.75 0 0 1 1.78.72L6 4.94V1.75A.75.75 0 0 1 6.75 1ZM9.25 15a.75.75 0 0 1-.75-.75v-5a.75.75 0 0 1 .75-.75h5a.75.75 0 0 1 0 1.5h-3.19l4.22 4.22a.75.75 0 1 1-1.06 1.06L10 11.06v3.19a.75.75 0 0 1-.75.75Z"/></svg>
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 1a.75.75 0 0 0 0 1.5h3.19L.72 6.72a.75.75 0 0 0 1.06 1.06L6 3.56v3.19a.75.75 0 0 0 1.5 0v-5A.75.75 0 0 0 6.75 1h-5ZM14.25 15a.75.75 0 0 0 0-1.5h-3.19l4.22-4.22a.75.75 0 1 0-1.06-1.06L10 12.44V9.25a.75.75 0 0 0-1.5 0v5c0 .414.336.75.75.75h5Z"/></svg>
                  )}
                </button>
              </Tooltip>
              <Tooltip content={copied ? 'Copied!' : 'Copy markdown'}>
                <button
                  className="ln-ai-description-action"
                  onClick={handleCopy}
                  aria-label="Copy markdown"
                >
                  {copied ? (
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z"/></svg>
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>
                  )}
                </button>
              </Tooltip>
              <Tooltip content={rawMode ? 'Show rendered' : 'Show raw markdown'}>
                <button
                  className="ln-ai-description-action"
                  onClick={() => setRawMode(v => !v)}
                  aria-label="Toggle raw markdown"
                >
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M0 1.75A.75.75 0 0 1 .75 1h4.253c1.227 0 2.317.59 3 1.501A3.743 3.743 0 0 1 11.006 1h3.245a.75.75 0 0 1 .75.75v10.5a.75.75 0 0 1-.75.75h-3.245a2.232 2.232 0 0 0-1.722.81.75.75 0 0 1-1.118-.042A2.23 2.23 0 0 0 6.5 13H.75a.75.75 0 0 1-.75-.75Zm7.251 9.674.001.001L7.25 12h-.001l.002-.575ZM6.5 11.5c.156 0 .31.01.462.03a3.75 3.75 0 0 1-.462-.03Zm1-.001.007.001h-.007ZM7.5 3.5A2.25 2.25 0 0 0 5.253 2.5H1.5v8h5.25c.125 0 .248.01.37.026A2.253 2.253 0 0 1 7.5 9V3.5Zm1.5 5.5a2.25 2.25 0 0 1 .38-1.266A.752.752 0 0 0 9.5 7.5V3.5A2.25 2.25 0 0 1 11.753 2.5H14.5v8h-3.244A2.242 2.242 0 0 0 9 10.5Z"/></svg>
                </button>
              </Tooltip>
              <button
                className="ln-ai-description-close"
                onClick={handleCollapse}
                aria-label="Collapse description"
              >
                &#x25B2;
              </button>
            </div>
          </div>
          <div className="ln-ai-description-body">
            {rawMode ? (
              <pre className="ln-ai-description-raw">{description}</pre>
            ) : (
              <div className="ln-ai-description-md">
                <Markdown
                  remarkPlugins={[remarkGfm, remarkMath]}
                  rehypePlugins={[rehypeKatex]}
                  components={{ a: AnchorComponent, h3: H3Component }}
                >{processedDescription}</Markdown>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});
