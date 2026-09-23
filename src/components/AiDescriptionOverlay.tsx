import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { FloatingPortal } from '@floating-ui/react';
import 'katex/dist/katex.min.css';
import { Tooltip } from './ui/Tooltip';
import { useDropdown } from '../hooks/useDropdown';
import { useVsCode } from '../contexts/VsCodeContext';
import { AI_SECTION_ID_PREFIX, renderAiMarkdown } from './markdown/renderAiMarkdown';
import { FOCUS_NODE_HREF_PREFIX } from '../engine/shared/bridgeContract';
import { SHORTCUT_KEYS } from '../ui/keyboardShortcuts';

/** Which edge of the canvas the report column is docked against. */
export type AiDockPosition = 'right' | 'left' | 'bottom';

/**
 * The dock choices, in the order the menu lists them.
 *
 * @remarks
 * One dropdown rather than three always-visible buttons: the trigger already shows the current
 * edge through its icon, so the header carries a single control and every position stays one
 * click away in the menu — the same shape VS Code uses for its own "Move Panel To" layout menu.
 */
const DOCK_CHOICES: ReadonlyArray<{ position: AiDockPosition; label: string }> = [
  { position: 'left', label: 'Dock left' },
  { position: 'bottom', label: 'Dock bottom' },
  { position: 'right', label: 'Dock right' },
];

/**
 * The collapsed rail's expand glyph, per dock edge: it points the way the panel will reopen.
 *
 * @remarks
 * A right- or left-docked rail is a vertical tab and reopens sideways into the canvas; a
 * bottom-docked rail is a horizontal strip and reopens upward. The arrow is the only part of the
 * rail that changes with the edge — the name and the hit target are identical on all three.
 */
const RAIL_TOGGLE_GLYPH: Readonly<Record<AiDockPosition, string>> = {
  right: '\u25C0',
  left: '\u25B6',
  bottom: '\u25B2',
};

/** The collapse arrow points toward the edge the panel folds into — the reverse of the rail's reopen arrow. */
const COLLAPSE_GLYPH: Readonly<Record<AiDockPosition, string>> = {
  right: '\u25B6',
  left: '\u25C0',
  bottom: '\u25BC',
};

/**
 * Panel-dock icon: a frame with the docked edge filled, modelled on VS Code's
 * `layout-panel-left` / `layout-panel` / `layout-panel-right` codicons so each position reads
 * at a glance instead of three near-identical arrow glyphs.
 */
function DockIcon({ position }: { position: AiDockPosition }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" />
      {position === 'left' && <rect x="2.5" y="3.5" width="3.5" height="9" rx="0.5" fill="currentColor" />}
      {position === 'right' && <rect x="10" y="3.5" width="3.5" height="9" rx="0.5" fill="currentColor" />}
      {position === 'bottom' && <rect x="2.5" y="9" width="11" height="3.5" rx="0.5" fill="currentColor" />}
    </svg>
  );
}

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
  /** Called when the user (de)selects a section chip — the canvas highlights that section's nodes. */
  onFocusSection?: (n: number | null) => void;
  /** Called when a `#focus-node:<nodeId>` link is clicked — zooms the graph to that node. */
  onFocusNode?: (nodeId: string) => void;
  /** Which edge the column is docked against — defaults to `'right'`. */
  dockPosition?: AiDockPosition;
  /** Called with the position picked from the dock menu. */
  onDockPositionChange?: (position: AiDockPosition) => void;
  /** Called with the panel's measured content-box size (a resize drag or dock switch changed it). */
  onPanelResize?: (width: number, height: number) => void;
}

/**
 * The AI report column: a pane docked to the chosen edge for AI-generated descriptions and logic summaries.
 *
 * @remarks
 * Renders GitHub Flavored Markdown and KaTeX math through the same `marked` extension VS Code
 * applies to chat responses, so a description renders identically in both surfaces. When
 * collapsed it shrinks to a slim rail on the edge it was docked to instead of disappearing, so
 * reopening never hunts for a button. Numbered section
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
  onFocusSection,
  onFocusNode,
  dockPosition = 'right',
  onDockPositionChange,
  onPanelResize,
}: AiDescriptionOverlayProps) {
  const vscodeApi = useVsCode();
  const [maximized, setMaximized] = useState(false);
  const [fontScale, setFontScale] = useState<0 | 1 | 2>(0);
  const dockMenu = useDropdown();

  const anchorRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!expanded || !onPanelResize) return;
    const el = anchorRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) onPanelResize(Math.round(entry.contentRect.width), Math.round(entry.contentRect.height));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [expanded, onPanelResize]);

  const litSections = activeSection != null ? [activeSection] : [];

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const savedScrollTop = useRef(0);
  useEffect(() => {
    if (expanded && bodyRef.current) bodyRef.current.scrollTop = savedScrollTop.current;
  }, [expanded]);

  useEffect(() => {
    if (activeSection == null) return;
    document.getElementById(`${AI_SECTION_ID_PREFIX}${activeSection}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [activeSection]);

  function handlePaneKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      handleCollapse();
      return;
    }
    if ((e.key !== SHORTCUT_KEYS.aiSectionPrevious && e.key !== SHORTCUT_KEYS.aiSectionNext) || !sections?.length) return;
    e.preventDefault();
    const idx = activeSection == null ? -1 : sections.findIndex(s => s.n === activeSection);
    const nextIdx = e.key === SHORTCUT_KEYS.aiSectionNext ? Math.min(idx + 1, sections.length - 1) : Math.max(idx - 1, 0);
    onFocusSection?.(sections[nextIdx].n);
  }

  function focusNodeFromHref(href: string): (() => void) | null {
    if (!href.startsWith(FOCUS_NODE_HREF_PREFIX) || !onFocusNode) return null;
    const encoded = href.slice(FOCUS_NODE_HREF_PREFIX.length);
    let nodeId = encoded;
    try {
      nodeId = decodeURIComponent(encoded);
    } catch (err) {
      vscodeApi.postMessage({ type: 'log', level: 'debug', text: `[AI] focus link decode failed: ${encoded} (${err instanceof Error ? err.message : String(err)})` });
    }
    return () => onFocusNode(nodeId);
  }

  function activateMarkdownLink(e: React.SyntheticEvent<HTMLDivElement>): void {
    const anchor = (e.target as HTMLElement | null)?.closest('a');
    const href = anchor?.getAttribute('href');
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

  function handleMarkdownClick(e: React.MouseEvent<HTMLDivElement>) {
    activateMarkdownLink(e);
  }

  function handleMarkdownKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === ' ') activateMarkdownLink(e);
  }

  function handleCollapse() {
    setMaximized(false);
    onExpandedChange?.(false);
  }

  function handleOpenInEditor() {
    vscodeApi.postMessage({ type: 'ai-open-in-editor', markdown: description });
  }

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
    dockPosition !== 'right' ? `ln-ai-description-anchor-${dockPosition}` : '',
    maximized ? 'ln-ai-description-anchor-maximized' : '',
  ].filter(Boolean).join(' ');
  const railwrapClassName = [
    'ln-ai-description-railwrap',
    dockPosition !== 'right' ? `ln-ai-description-railwrap--${dockPosition}` : '',
  ].filter(Boolean).join(' ');

  if (!expanded) {
    return (
      <div className={railwrapClassName}>
        <button
          className="ln-ai-description-rail"
          onClick={() => onExpandedChange?.(true)}
          aria-expanded={false}
          aria-label="Expand AI report"
        >
          <span className="ln-ai-description-rail-name">{railName}</span>
          <span className="ln-ai-description-rail-toggle">{RAIL_TOGGLE_GLYPH[dockPosition]}</span>
        </button>
      </div>
    );
  }

  return (
    <div className={anchorClassName} ref={anchorRef}>
      <div className={overlayClassName} onKeyDown={handlePaneKeyDown}>
        <div className="ln-ai-description-header">
          <span className="ln-ai-description-title text-[10px] font-semibold ln-text-muted uppercase tracking-wide">
            {railName}
          </span>
          <div className="ln-ai-description-actions">
            <Tooltip content="Dock report panel">
              <button
                ref={dockMenu.refs.setReference}
                className="ln-ai-description-action ln-ai-dock-trigger"
                onClick={dockMenu.toggle}
                aria-label="Report panel dock position"
                aria-haspopup="menu"
                aria-expanded={dockMenu.isOpen}
              >
                <DockIcon position={dockPosition} />
                <svg className="ln-ai-dock-chevron" width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                  <path d="M3 6l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </Tooltip>
            <FloatingPortal>
              {dockMenu.isOpen && (
                <div
                  ref={dockMenu.refs.setFloating}
                  style={{ ...dockMenu.floatingStyles, boxShadow: 'var(--ln-dropdown-shadow)' }}
                  className="ln-dropdown rounded-md z-50 p-1"
                  role="menu"
                  aria-label="Report panel dock position"
                  {...dockMenu.getFloatingProps()}
                >
                  {DOCK_CHOICES.map(choice => (
                    <button
                      key={choice.position}
                      className="ln-ai-dock-menu-item"
                      role="menuitemradio"
                      aria-checked={dockPosition === choice.position}
                      onClick={() => {
                        onDockPositionChange?.(choice.position);
                        dockMenu.close();
                      }}
                    >
                      <span className="ln-ai-dock-menu-check" aria-hidden="true">
                        {dockPosition === choice.position ? '✓' : ''}
                      </span>
                      <DockIcon position={choice.position} />
                      {choice.label}
                    </button>
                  ))}
                </div>
              )}
            </FloatingPortal>
            <Tooltip content="Open in editor">
              <button
                className="ln-ai-description-action"
                onClick={handleOpenInEditor}
                aria-label="Open description in editor"
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M13.75 7a.75.75 0 0 1 .75.75v5.5A1.75 1.75 0 0 1 12.75 15h-9.5A1.75 1.75 0 0 1 1.5 13.25v-9.5A1.75 1.75 0 0 1 3.25 2h5.5a.75.75 0 0 1 0 1.5h-5.5a.25.25 0 0 0-.25.25v9.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25v-5.5a.75.75 0 0 1 .75-.75Z"/><path d="M14.5 1.5h-4a.75.75 0 0 0 0 1.5h2.19L6.22 9.47a.75.75 0 1 0 1.06 1.06L13.75 4V6.5a.75.75 0 0 0 1.5 0v-4a.75.75 0 0 0-.75-.75Z"/></svg>
              </button>
            </Tooltip>
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
            <button
              className="ln-ai-description-close"
              onClick={handleCollapse}
              aria-label="Collapse description"
            >
              {COLLAPSE_GLYPH[dockPosition]}
            </button>
          </div>
        </div>
        {sections && sections.length > 0 && (
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
          <div
            className="ln-ai-description-md"
            onClick={handleMarkdownClick}
            onKeyDown={handleMarkdownKeyDown}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      </div>
    </div>
  );
});
