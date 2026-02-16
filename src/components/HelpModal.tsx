import { memo } from 'react';
import { useVsCode } from '../contexts/VsCodeContext';

interface HelpModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const HelpModal = memo(function HelpModal({ isOpen, onClose }: HelpModalProps) {
  const vscodeApi = useVsCode();
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 ln-modal-overlay"
      onClick={onClose}
    >
      <div
        className="rounded-xl shadow-2xl p-8 max-w-3xl max-h-[85vh] overflow-y-auto ln-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-6 pb-4 ln-border-bottom">
          <div className="flex justify-end mb-4">
            <button
              onClick={onClose}
              className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors ln-list-item ln-text"
              title="Close"
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className="flex flex-col items-center text-center gap-4">
            <img
              src={window.LOGO_URI || '../images/logo.png'}
              alt="Data Lineage Viz"
              className="h-16 w-auto"
              onError={(e) => {
                const target = e.target as HTMLImageElement;
                target.style.display = 'none';
                const fallback = document.createElement('div');
                fallback.className = 'text-3xl font-bold ln-text';
                fallback.textContent = 'Data Lineage Viz';
                target.parentElement?.appendChild(fallback);
              }}
            />
            <div>
              <p className="text-base ln-text-muted">
                SQL Server Database Project Dependency Viewer
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-6 ln-text">
          <section>
            <div className="flex items-center gap-2 mb-3">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5 ln-text-link">
                <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
              </svg>
              <h3 className="text-lg font-semibold">Search & Navigation</h3>
            </div>
            <div className="ml-7 space-y-2 text-sm ln-text-muted">
              <div className="flex items-start gap-2">
                <span className="text-xs mt-0.5">•</span>
                <span>Type <strong>2+ characters</strong> to see autocomplete suggestions</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-xs mt-0.5">•</span>
                <span>Press <kbd className="px-1.5 py-0.5 rounded text-xs ln-kbd">Enter</kbd> to navigate and zoom to selected object</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-xs mt-0.5">•</span>
                <span>Results are filtered by currently active schemas and types</span>
              </div>
            </div>
          </section>

          <section>
            <div className="flex items-center gap-2 mb-3">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5 ln-text-link">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 3c2.755 0 5.455.232 8.083.678.533.09.917.556.917 1.096v1.044a2.25 2.25 0 0 1-.659 1.591l-5.432 5.432a2.25 2.25 0 0 0-.659 1.591v2.927a2.25 2.25 0 0 1-1.244 2.013L9.75 21v-6.568a2.25 2.25 0 0 0-.659-1.591L3.659 7.409A2.25 2.25 0 0 1 3 5.818V4.774c0-.54.384-1.006.917-1.096A48.32 48.32 0 0 1 12 3Z" />
              </svg>
              <h3 className="text-lg font-semibold">Filters & Visibility</h3>
            </div>
            <div className="ml-7 space-y-2 text-sm ln-text-muted">
              <div className="flex items-start gap-2">
                <span className="text-xs mt-0.5">•</span>
                <span><strong>Schema Filter:</strong> Multi-select dropdown to show/hide specific schemas</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-xs mt-0.5">•</span>
                <span><strong>Type Filter:</strong> Toggle visibility for tables, views, procedures, and functions</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-xs mt-0.5">•</span>
                <span><strong>Hide Isolated:</strong> Hide nodes with no connections</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-xs mt-0.5">•</span>
                <span><strong>Focus Schema:</strong> Star a schema to highlight it and directly connected objects</span>
              </div>
            </div>
          </section>

          <section>
            <div className="flex items-center gap-2 mb-3">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5 ln-text-link">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z" />
              </svg>
              <h3 className="text-lg font-semibold">Trace Mode</h3>
            </div>
            <div className="ml-7 space-y-2 text-sm ln-text-muted">
              <div className="flex items-start gap-2">
                <span className="text-xs mt-0.5">•</span>
                <span><strong>Trace Levels:</strong> right-click → "Trace Levels" to explore upstream/downstream dependencies with configurable depth</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-xs mt-0.5">•</span>
                <span><strong>Find Path:</strong> right-click → "Find Path" to discover the shortest connection between two nodes</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-xs mt-0.5">•</span>
                <span><strong>Graph filter:</strong> both modes filter the graph to show only relevant connections</span>
              </div>
            </div>
          </section>

          <section>
            <div className="flex items-center gap-2 mb-3">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5 ln-text-link">
                <path strokeLinecap="round" strokeLinejoin="round" d="m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z" />
              </svg>
              <h3 className="text-lg font-semibold">Node Details Bar</h3>
            </div>
            <div className="ml-7 space-y-2 text-sm ln-text-muted">
              <div className="flex items-start gap-2">
                <span className="text-xs mt-0.5">•</span>
                <span><strong>Right-click</strong> any node → "Show Details" to open the bottom info bar</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-xs mt-0.5">•</span>
                <span><strong>In / Out</strong> — count of connected input and output nodes (hover for full list)</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-xs mt-0.5">•</span>
                <span><strong>Unresolved</strong> — SQL references not found in the dacpac (e.g. external tables)</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-xs mt-0.5">•</span>
                <span><strong>Excluded</strong> — nodes removed by your exclusion patterns setting</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-xs mt-0.5">•</span>
                <span><strong>Tip:</strong> click another node to update the bar; click ✕ to close</span>
              </div>
            </div>
          </section>

          <section>
            <div className="flex items-center gap-2 mb-3">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5 ln-text-link">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v11.25A2.25 2.25 0 0 0 6 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0 1 18 16.5h-2.25m-7.5 0h7.5m-7.5 0-1 3m8.5-3 1 3m0 0 .5 1.5m-.5-1.5h-9.5m0 0-.5 1.5m.75-9 3-3 2.148 2.148A12.061 12.061 0 0 1 16.5 7.605" />
              </svg>
              <h3 className="text-lg font-semibold">Graph Analysis</h3>
            </div>
            <div className="ml-7 space-y-2 text-sm ln-text-muted">
              <div className="flex items-start gap-2">
                <span className="text-xs mt-0.5">•</span>
                <span><strong>Islands:</strong> find disconnected subgraphs</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-xs mt-0.5">•</span>
                <span><strong>Hubs:</strong> identify most-connected nodes</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-xs mt-0.5">•</span>
                <span><strong>Orphan Nodes:</strong> reveal objects with no dependencies</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-xs mt-0.5">•</span>
                <span><strong>Longest Path:</strong> find the deepest dependency chains from source to sink</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-xs mt-0.5">•</span>
                <span><strong>Cycles:</strong> detect circular dependencies in your data flow</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-xs mt-0.5">•</span>
                <span>Click a group in the sidebar to zoom into that subset</span>
              </div>
            </div>
          </section>

          <section>
            <div className="flex items-center gap-2 mb-3">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5 ln-text-link">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
              </svg>
              <h3 className="text-lg font-semibold">Export</h3>
            </div>
            <div className="ml-7 space-y-2 text-sm ln-text-muted">
              <div className="flex items-start gap-2">
                <span className="text-xs mt-0.5">•</span>
                <span><strong>Draw.io:</strong> editable <code>.drawio</code> file with colored nodes, edges, and schema legend</span>
              </div>
            </div>
          </section>

          <section>
            <div className="flex items-center gap-2 mb-3">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5 ln-text-link">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 6.75V15m6-6v8.25m.503 3.498 4.875-2.437c.381-.19.622-.58.622-1.006V4.82c0-.836-.88-1.38-1.628-1.006l-3.869 1.934c-.317.159-.69.159-1.006 0L9.503 3.252a1.125 1.125 0 0 0-1.006 0L3.622 5.689C3.24 5.88 3 6.27 3 6.695V19.18c0 .836.88 1.38 1.628 1.006l3.869-1.934c.317-.159.69-.159 1.006 0l4.994 2.497c.317.158.69.158 1.006 0Z" />
              </svg>
              <h3 className="text-lg font-semibold">MiniMap</h3>
            </div>
            <div className="ml-7 space-y-2 text-sm ln-text-muted">
              <div className="flex items-start gap-2">
                <span className="text-xs mt-0.5">•</span>
                <span>Drag the viewport rectangle to pan around the graph</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-xs mt-0.5">•</span>
                <span>Scroll on the minimap to zoom in and out</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-xs mt-0.5">•</span>
                <span>Toggle via <strong>Settings</strong> &gt; <code>dataLineageViz.layout.minimapEnabled</code></span>
              </div>
            </div>
          </section>

          <section>
            <div className="flex items-center gap-2 mb-3">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5 ln-text-link">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 0 1 0 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 0 1 0-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z" />
              </svg>
              <h3 className="text-lg font-semibold">Settings Reference</h3>
            </div>
            <div className="ml-7 space-y-3 text-sm ln-text-muted">
              <p>All settings use the <code>dataLineageViz.*</code> prefix. Open via <strong>Settings</strong> button below or <kbd className="px-1.5 py-0.5 rounded text-xs ln-kbd">Ctrl+,</kbd> and search "dataLineageViz".</p>
              <div className="p-2 rounded ln-bg-secondary">
                <p><strong className="ln-text">Most settings apply automatically</strong> when changed in VS Code Settings.</p>
                <p className="mt-1"><strong className="ln-text">Parse Rules</strong> (<code>parseRulesFile</code>) require re-importing the dacpac — you'll see a notification when this setting changes.</p>
              </div>
              <div>
                <p className="font-semibold ln-text mb-1">General</p>
                <div className="flex items-start gap-2">
                  <span className="text-xs mt-0.5">•</span>
                  <span><code>maxNodes</code> — Maximum objects for import (default: 500)</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-xs mt-0.5">•</span>
                  <span><code>logLevel</code> — Log verbosity: info or debug (default: info)</span>
                </div>
              </div>
              <div>
                <p className="font-semibold ln-text mb-1">Import</p>
                <div className="flex items-start gap-2">
                  <span className="text-xs mt-0.5">•</span>
                  <span><code>parseRulesFile</code> — Path to custom parseRules.yaml (default: empty = built-in)</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-xs mt-0.5">•</span>
                  <span><code>excludePatterns</code> — Regex patterns to exclude objects from the graph</span>
                </div>
              </div>
              <div>
                <p className="font-semibold ln-text mb-1">Layout</p>
                <div className="flex items-start gap-2">
                  <span className="text-xs mt-0.5">•</span>
                  <span><code>layout.direction</code> — LR (horizontal) or TB (vertical) (default: LR)</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-xs mt-0.5">•</span>
                  <span><code>layout.rankSeparation</code> — Spacing between layers (default: 120)</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-xs mt-0.5">•</span>
                  <span><code>layout.nodeSeparation</code> — Spacing within a layer (default: 30)</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-xs mt-0.5">•</span>
                  <span><code>edgeStyle</code> — Edge style: default, smoothstep, step, straight</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-xs mt-0.5">•</span>
                  <span><code>layout.edgeAnimation</code> — Animate traced edges (default: on)</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-xs mt-0.5">•</span>
                  <span><code>layout.highlightAnimation</code> — Animate on node click (default: off)</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-xs mt-0.5">•</span>
                  <span><code>layout.minimapEnabled</code> — Show minimap (default: on)</span>
                </div>
              </div>
              <div>
                <p className="font-semibold ln-text mb-1">Trace</p>
                <div className="flex items-start gap-2">
                  <span className="text-xs mt-0.5">•</span>
                  <span><code>trace.defaultUpstreamLevels</code> — Default upstream depth (default: 3)</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-xs mt-0.5">•</span>
                  <span><code>trace.defaultDownstreamLevels</code> — Default downstream depth (default: 3)</span>
                </div>
              </div>
              <div>
                <p className="font-semibold ln-text mb-1">Analysis</p>
                <div className="flex items-start gap-2">
                  <span className="text-xs mt-0.5">•</span>
                  <span><code>analysis.hubMinDegree</code> — Min connections for Hub analysis (default: 8)</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-xs mt-0.5">•</span>
                  <span><code>analysis.islandMaxSize</code> — Max island size to show (default: 2, min: 2)</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-xs mt-0.5">•</span>
                  <span><code>analysis.longestPathMinNodes</code> — Min chain length for Longest Path (default: 5)</span>
                </div>
              </div>
            </div>
          </section>

          <section>
            <div className="flex items-center gap-2 mb-3">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5 ln-text-link">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
              </svg>
              <h3 className="text-lg font-semibold">Keyboard Shortcuts</h3>
            </div>
            <div className="ml-7 space-y-2 text-sm ln-text-muted">
              <div className="flex items-start gap-2">
                <kbd className="px-2 py-1 rounded text-xs font-mono ln-kbd">Esc</kbd>
                <span>Close analysis, clear trace, or close context menu</span>
              </div>
              <div className="flex items-start gap-2">
                <kbd className="px-2 py-1 rounded text-xs font-mono ln-kbd">Enter</kbd>
                <span>Navigate to selected autocomplete result</span>
              </div>
            </div>
          </section>
        </div>

        <div className="mt-8 pt-6 flex items-center justify-between ln-border-top">
          <div className="text-xs ln-text-muted">
            <p className="mb-1">Data Lineage Viz v0.9.0</p>
            <p>SQL Server Database Project Dependency Viewer</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                vscodeApi.postMessage({ type: 'open-settings' });
              }}
              className="flex items-center gap-2 px-3 py-2 rounded-lg transition-colors text-sm ln-btn-secondary ln-text hover:ln-list-item cursor-pointer"
              title="Open Extension Settings"
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              Settings
            </button>
            <button
              onClick={() => {
                vscodeApi.postMessage({
                  type: 'open-external',
                  url: 'https://www.linkedin.com/in/christian-wagner-11aa8614b'
                });
              }}
              className="flex items-center gap-2 px-3 py-2 rounded-lg transition-colors text-sm ln-btn-secondary ln-text-link hover:underline cursor-pointer"
              title="Connect on LinkedIn"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
                <path d="M0 1.146C0 .513.526 0 1.175 0h13.65C15.474 0 16 .513 16 1.146v13.708c0 .633-.526 1.146-1.175 1.146H1.175C.526 16 0 15.487 0 14.854V1.146zm4.943 12.248V6.169H2.542v7.225h2.401zm-1.2-8.212c.837 0 1.358-.554 1.358-1.248-.015-.709-.52-1.248-1.342-1.248-.822 0-1.359.54-1.359 1.248 0 .694.521 1.248 1.327 1.248h.016zm4.908 8.212V9.359c0-.216.016-.432.08-.586.173-.431.568-.878 1.232-.878.869 0 1.216.662 1.216 1.634v3.865h2.401V9.25c0-2.22-1.184-3.252-2.764-3.252-1.274 0-1.845.7-2.165 1.193v.025h-.016a5.54 5.54 0 0 1 .016-.025V6.169h-2.4c.03.678 0 7.225 0 7.225h2.4z"/>
              </svg>
              LinkedIn
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});
