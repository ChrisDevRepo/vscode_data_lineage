import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import 'katex/dist/katex.min.css';
import { Tooltip } from './ui/Tooltip';
import { AI_SECTION_ID_PREFIX, FOCUS_NODE_HREF_PREFIX, renderAiMarkdown } from './markdown/renderAiMarkdown';

/** How long the copy button reads "Copied" before it reverts. */
const COPIED_FEEDBACK_MS = 2000;

/** One numbered report section, derived client-side from the bridged badge chips (`"N label"`). */
export interface AiReportSection {
  /** The engine-assigned section number, matching the `## N` heading in the description. */
  n: number;
  /** The section label as the engine wrote it onto the badges. */
  label: string;
  /** Node ids badged with this section number — the highlight set when the section is focused. */
  nodeIds: string[];
}

interface AiDescriptionOverlayProps {
  /** The name of the AI-generated view or analysis. */
  viewName: string;
  /** The markdown-formatted description text to display. */
  description: string;
  /** Whether the report column is expanded — controlled by the canvas so it can reserve width. */
  expanded: boolean;
  /** Called when the user expands or collapses the column. */
  onExpandedChange?: (expanded: boolean) => void;
  /** Numbered sections for the navigation chips; absent when no badges were bridged. */
  sections?: readonly AiReportSection[];
  /** The focused section number, or `null` when no section focus is active — the scroll target. */
  activeSection?: number | null;
  /** Chips to render active — defaults to `[activeSection]`; a clicked node in several sections
   *  lights up all of them, while only the first (`activeSection`) is scrolled to and dimmed. */
  highlightedSections?: readonly number[];
  /** Called when the user (de)selects a section chip — the canvas highlights that section's nodes. */
  onFocusSection?: (n: number | null) => void;
  /** Called when a `#focus-node:<nodeId>` link is clicked — zooms the graph to that node. */
  onFocusNode?: (nodeId: string) => void;
}

/**
 * The AI report column: a docked right-hand pane for AI-generated descriptions and logic summaries.
 *
 * @remarks
 * Renders GitHub Flavored Markdown and KaTeX math through the same `marked` extension VS Code
 * applies to chat responses, so a description renders identically in both surfaces. Raw source
 * and clipboard copy are also available. When collapsed it shrinks to a slim vertical rail on the
 * right edge instead of disappearing, so reopening never hunts for a button. Numbered section
 * chips navigate the document and, through `onFocusSection`, highlight that section's nodes on
 * the graph while the rest dim.
 *
 * @param props - The component props.
 */
export const AiDescriptionOverlay = memo(function AiDescriptionOverlay({
  viewName,
  description,
  expanded,
  onExpandedChange,
  sections,
  activeSection,
  highlightedSections,
  onFocusSection,
  onFocusNode,
}: AiDescriptionOverlayProps) {
  const [rawMode, setRawMode] = useState(false);
  const [copied, setCopied] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [fontScale, setFontScale] = useState<0 | 1 | 2>(0);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current); }, []);

  // The chip row lights every section a node click matched; a plain focus (chip click, keyboard
  // nav, restored layout) has no multi-highlight, so it falls back to just the active one.
  const litSections = highlightedSections ?? (activeSection != null ? [activeSection] : []);

  // Body scroll survives collapse/expand: the rail swap unmounts `.ln-ai-description-body`, so its
  // native scrollTop is lost — captured on every scroll and reapplied once the body remounts.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const savedScrollTop = useRef(0);
  useEffect(() => {
    if (expanded && bodyRef.current) bodyRef.current.scrollTop = savedScrollTop.current;
  }, [expanded]);

  // A chip click, node click or restored layout all land here through `activeSection` — one path
  // scrolls the document, so a node click reaches its section the same way a chip does.
  useEffect(() => {
    if (activeSection == null) return;
    document.getElementById(`${AI_SECTION_ID_PREFIX}${activeSection}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [activeSection]);

  /** `[` / `]` step to the previous/next section while the pane has focus. */
  function handlePaneKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if ((e.key !== '[' && e.key !== ']') || !sections?.length) return;
    e.preventDefault();
    const idx = activeSection == null ? -1 : sections.findIndex(s => s.n === activeSection);
    const nextIdx = e.key === ']' ? Math.min(idx + 1, sections.length - 1) : Math.max(idx - 1, 0);
    onFocusSection?.(sections[nextIdx].n);
  }

  function focusNodeFromEvent(target: EventTarget | null): (() => void) | null {
    const anchor = (target as HTMLElement | null)?.closest('a');
    const href = anchor?.getAttribute('href');
    if (!href?.startsWith(FOCUS_NODE_HREF_PREFIX) || !onFocusNode) {
      return null;
    }
    const encoded = href.slice(FOCUS_NODE_HREF_PREFIX.length);
    let nodeId = encoded;
    try {
      nodeId = decodeURIComponent(encoded);
    } catch (err) {
      // A malformed escape in an assembled link must not trip the graph error boundary.
      window.vscode?.postMessage({ type: 'log', level: 'debug', text: `[AI] focus link decode failed: ${encoded} (${err instanceof Error ? err.message : String(err)})` });
    }
    return () => onFocusNode(nodeId);
  }

  function activateFocusNode(e: React.SyntheticEvent<HTMLDivElement>) {
    const focus = focusNodeFromEvent(e.target);
    if (!focus) return;
    e.preventDefault();
    focus();
  }

  function handleMarkdownClick(e: React.MouseEvent<HTMLDivElement>) {
    activateFocusNode(e);
  }

  // Enter reaches the click handler through the anchor's own activation behaviour; Space does not
  // activate a link, so without this the keyboard path is Enter-only.
  function handleMarkdownKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === ' ') activateFocusNode(e);
  }

  /**
   * Copies the raw markdown description to the system clipboard.
   */
  function handleCopy() {
    navigator.clipboard.writeText(description).then(() => {
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    }).catch(err => window.vscode?.postMessage({ type: 'error', error: `Clipboard write failed: ${err instanceof Error ? err.message : String(err)}` }));
  }

  function handleCollapse() {
    setMaximized(false);
    onExpandedChange?.(false);
  }

  /**
   * A chip click toggles that section's graph focus; the `activeSection` effect above scrolls the
   * report to its `## N` heading once the prop change comes back down.
   */
  function handleSectionChip(n: number) {
    onFocusSection?.(activeSection === n ? null : n);
  }

  const html = useMemo(() => renderAiMarkdown(description), [description]);
  const railName = viewName || 'AI Report';
  const overlayClassName = [
    'ln-ai-description-overlay',
    maximized ? 'ln-ai-description-overlay-maximized' : '',
    `ln-ai-description-font-${fontScale}`,
  ].filter(Boolean).join(' ');
  const anchorClassName = [
    'ln-ai-description-anchor',
    maximized ? 'ln-ai-description-anchor-maximized' : '',
  ].filter(Boolean).join(' ');

  if (!expanded) {
    return (
      <div className="ln-ai-description-railwrap">
        <button
          className="ln-ai-description-rail"
          onClick={() => onExpandedChange?.(true)}
          aria-expanded={false}
          aria-label="Expand AI report"
        >
          <span className="ln-ai-description-rail-name">{railName}</span>
          <span className="ln-ai-description-rail-toggle">&#x25C0;</span>
        </button>
      </div>
    );
  }

  return (
    <div className={anchorClassName}>
      <div className={overlayClassName} onKeyDown={handlePaneKeyDown}>
        <div className="ln-ai-description-header">
          <span className="ln-ai-description-title text-[10px] font-semibold ln-text-muted uppercase tracking-wide">
            {railName}
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
              &#x25B6;
            </button>
          </div>
        </div>
        {!rawMode && sections && sections.length > 0 && (
          <div className="ln-ai-section-chips" role="navigation" aria-label="Report sections">
            {sections.map(section => (
              <button
                key={section.n}
                className={`ln-ai-section-chip${litSections.includes(section.n) ? ' ln-active' : ''}`}
                onClick={() => handleSectionChip(section.n)}
                aria-pressed={litSections.includes(section.n)}
                title={`${section.n} ${section.label}`}
              >
                {section.n} {section.label}
              </button>
            ))}
          </div>
        )}
        <div
          ref={bodyRef}
          className="ln-ai-description-body"
          onScroll={(e) => { savedScrollTop.current = e.currentTarget.scrollTop; }}
        >
          {rawMode ? (
            <pre className="ln-ai-description-raw">{description}</pre>
          ) : (
            <div
              className="ln-ai-description-md"
              onClick={handleMarkdownClick}
              onKeyDown={handleMarkdownKeyDown}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}
        </div>
      </div>
    </div>
  );
});
