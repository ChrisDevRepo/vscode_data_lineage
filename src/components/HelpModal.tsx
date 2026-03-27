import { memo, useState } from 'react';
import { useVsCode } from '../contexts/VsCodeContext';
import { CloseIcon } from './ui/CloseIcon';

interface HelpModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type HelpTab = 'overview' | 'analysis' | 'database' | 'ai';

const TABS: Array<{ id: HelpTab; label: string }> = [
  { id: 'overview',  label: 'Overview'   },
  { id: 'analysis',  label: 'Analysis'   },
  { id: 'database',  label: 'Database'   },
  { id: 'ai',        label: '@lineage AI' },
];

// ─── Section header ───────────────────────────────────────────────────────────

function SectionHeader({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      {icon}
      <h3 className="text-sm font-semibold ln-text">{title}</h3>
    </div>
  );
}

function IconPath({ d }: { d: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4 flex-shrink-0 ln-text-link">
      <path strokeLinecap="round" strokeLinejoin="round" d={d} />
    </svg>
  );
}

// ─── Tab: Overview ────────────────────────────────────────────────────────────

function TabOverview({ openExternal }: { openExternal: (url: string) => void }) {
  return (
    <div className="space-y-6">
      {/* Keyboard Shortcuts */}
      <section>
        <SectionHeader
          icon={<IconPath d="M12 3a1.5 1.5 0 0 0-1.5 1.5v1.5H9a1.5 1.5 0 0 0 0 3h1.5V12a1.5 1.5 0 0 0 3 0V9H15a1.5 1.5 0 0 0 0-3h-1.5V4.5A1.5 1.5 0 0 0 12 3ZM3 12a9 9 0 1 1 18 0 9 9 0 0 1-18 0Z" />}
          title="Keyboard Shortcuts"
        />
        <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm ln-text-muted">
          {[
            { key: '/', label: 'Focus Quick Search' },
            { key: 'F', label: 'Fit graph to view' },
            { key: 'Del', label: 'Exclude highlighted node' },
            { key: 'Esc', label: 'Close trace or analysis' },
            { key: '?', label: 'Open this Help' },
          ].map(({ key, label }) => (
            <div key={key} className="flex items-center gap-3">
              <kbd className="px-1.5 py-0.5 text-xs font-mono rounded border ln-kbd flex-shrink-0">{key}</kbd>
              <span>{label}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Filters & Visibility */}
      <section>
        <SectionHeader
          icon={<IconPath d="M12 3c2.755 0 5.455.232 8.083.678.533.09.917.556.917 1.096v1.044a2.25 2.25 0 0 1-.659 1.591l-5.432 5.432a2.25 2.25 0 0 0-.659 1.591v2.927a2.25 2.25 0 0 1-1.244 2.013L9.75 21v-6.568a2.25 2.25 0 0 0-.659-1.591L3.659 7.409A2.25 2.25 0 0 1 3 5.818V4.774c0-.54.384-1.006.917-1.096A48.32 48.32 0 0 1 12 3Z" />}
          title="Filters & Visibility"
        />
        <div className="space-y-1.5 text-sm ln-text-muted">
          {[
            { strong: 'Schema Filter:', text: 'Show only selected schemas — use the grid icon in the toolbar' },
            { strong: 'Type Filter:', text: 'Show/hide tables, views, procedures, functions, external tables' },
            { strong: 'Hide Isolated:', text: 'Hide nodes with no dependencies in the current view' },
            { strong: 'Focus Schema:', text: 'Star (☆) a schema to highlight it and its directly connected objects' },
          ].map(({ strong, text }) => (
            <div key={strong} className="flex items-start gap-2">
              <span className="text-xs mt-0.5 flex-shrink-0">•</span>
              <span><strong>{strong}</strong> {text}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Exclusion Rules */}
      <section>
        <SectionHeader
          icon={<IconPath d="M18.364 18.364A9 9 0 0 0 5.636 5.636m12.728 12.728A9 9 0 0 1 5.636 5.636m12.728 12.728L5.636 5.636" />}
          title="Exclusion Rules"
        />
        <div className="space-y-1.5 text-sm ln-text-muted">
          <div className="flex items-start gap-2">
            <span className="text-xs mt-0.5 flex-shrink-0">•</span>
            <span>Click the <strong>⊘ ban icon</strong> in the toolbar. Rules hide nodes in real-time — no reload needed.</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-xs mt-0.5 flex-shrink-0">•</span>
            <span><strong>Three ways to add:</strong> type a pattern + Enter · right-click a node → <strong>Exclude from view</strong> · select a node + <kbd className="px-1 py-0.5 text-xs font-mono rounded border ln-kbd">Del</kbd></span>
          </div>
        </div>
        <div className="mt-2 p-2 rounded text-xs font-mono" style={{ background: 'var(--ln-bg-secondary)', border: '1px solid var(--ln-border)' }}>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
            <span className="ln-text font-medium">%tmp%</span><span className="ln-text-muted">matches any name containing "tmp"</span>
            <span className="ln-text font-medium">dbo.%</span><span className="ln-text-muted">all objects in the dbo schema</span>
            <span className="ln-text font-medium">%_stg</span><span className="ln-text-muted">any name ending in "_stg"</span>
            <span className="ln-text font-medium">^dbo\.tmp_</span><span className="ln-text-muted">regex: starts with dbo.tmp_</span>
          </div>
          <p className="font-sans mt-1.5" style={{ color: 'var(--ln-fg-dim)' }}>Matched against <em>schema.name</em>. Case-insensitive. <code>%</code> is a wildcard (like SQL LIKE).</p>
        </div>
        <div className="mt-2 text-xs ln-text-muted">
          Exclusion rules are <strong>saved per bookmark</strong> — use Bookmarks (🔖) to save and restore views.{' '}
          <button onClick={() => openExternal('https://github.com/ChrisDevRepo/vscode_data_lineage/blob/main/README.md')} className="ln-text-link hover:underline cursor-pointer">
            Full reference ↗
          </button>
        </div>
      </section>

      {/* Trace Mode */}
      <section>
        <SectionHeader
          icon={<IconPath d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z" />}
          title="Trace Mode"
        />
        <div className="space-y-1.5 text-sm ln-text-muted">
          <div className="flex items-start gap-2">
            <span className="text-xs mt-0.5 flex-shrink-0">•</span>
            <span><strong>Trace Levels:</strong> right-click a node → "Trace Levels" to explore upstream/downstream dependencies with configurable depth</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-xs mt-0.5 flex-shrink-0">•</span>
            <span><strong>Find Path:</strong> right-click → "Find Path" to discover the shortest connection between two nodes</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-xs mt-0.5 flex-shrink-0">•</span>
            <span>Both modes filter the graph to show only relevant connections — press <kbd className="px-1 py-0.5 text-xs font-mono rounded border ln-kbd">Esc</kbd> to exit</span>
          </div>
        </div>
      </section>

      {/* Export */}
      <section>
        <SectionHeader
          icon={<IconPath d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />}
          title="Export"
        />
        <div className="text-sm ln-text-muted">
          <strong>Draw.io:</strong> exports an editable <code>.drawio</code> file with colored nodes, edges, and schema legend. Opens directly in diagrams.net or Draw.io Desktop.
        </div>
      </section>

      {/* Node Details Bar */}
      <section>
        <SectionHeader
          icon={<IconPath d="m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z" />}
          title="Node Details Bar"
        />
        <div className="space-y-1.5 text-sm ln-text-muted">
          <div className="flex items-start gap-2">
            <span className="text-xs mt-0.5 flex-shrink-0">•</span>
            <span><strong>Right-click</strong> any node → "Show Details" to open the bottom info bar</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-xs mt-0.5 flex-shrink-0">•</span>
            <span><strong>In / Out</strong> — count of connected input and output nodes (hover for full list)</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-xs mt-0.5 flex-shrink-0">•</span>
            <span><strong>Unresolved</strong> — SQL references not found in the data source (e.g. dynamic SQL, cross-server refs)</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-xs mt-0.5 flex-shrink-0">•</span>
            <span><strong>Excluded</strong> — nodes hidden by your exclusion patterns</span>
          </div>
        </div>
      </section>
    </div>
  );
}

// ─── Tab: Analysis ────────────────────────────────────────────────────────────

function TabAnalysis() {
  const analyses = [
    {
      icon: 'M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5',
      title: 'Islands',
      desc: 'Disconnected subgraphs — groups of objects with no edges connecting them to the rest of the graph.',
      tip: 'Spot orphaned schemas or isolated modules after migrations or refactoring.',
    },
    {
      icon: 'M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z',
      title: 'Hubs',
      desc: 'Nodes with the highest number of connections (total degree: in + out).',
      tip: 'High-degree SPs and views are change-risk hotspots — modifying them ripples widely.',
    },
    {
      icon: 'M18.364 18.364A9 9 0 0 0 5.636 5.636m12.728 12.728A9 9 0 0 1 5.636 5.636m12.728 12.728L5.636 5.636',
      title: 'Orphan Nodes',
      desc: 'Objects with zero connections — no edges in or out.',
      tip: 'Candidates for dead-code review; may be safe to archive or remove.',
    },
    {
      icon: 'M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3',
      title: 'Longest Path',
      desc: 'The deepest dependency chains from source (no inputs) to sink (no outputs).',
      tip: 'The longest chain = maximum blast radius. Changes at the source affect everything below.',
    },
    {
      icon: 'M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182',
      title: 'Cycles',
      desc: 'Circular dependencies where data flows back to its own origin.',
      tip: 'Cycles block incremental deployment and can cause infinite loops in data pipelines.',
    },
    {
      icon: 'M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25',
      title: 'External Refs',
      desc: 'File sources (OPENROWSET, COPY INTO) and cross-database references — virtual nodes with no local metadata.',
      tip: 'Virtual nodes show integration points to external systems, files, and other databases.',
    },
  ];

  return (
    <div className="space-y-3">
      {analyses.map(({ icon, title, desc, tip }) => (
        <div key={title} className="rounded-lg p-3" style={{ background: 'var(--ln-bg-elevated)', border: '1px solid var(--ln-border)' }}>
          <div className="flex items-center gap-2 mb-1.5">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 flex-shrink-0 ln-text-link">
              <path strokeLinecap="round" strokeLinejoin="round" d={icon} />
            </svg>
            <span className="text-sm font-semibold ln-text">{title}</span>
          </div>
          <p className="text-xs ln-text-muted mb-1">{desc}</p>
          <p className="text-xs" style={{ color: 'var(--ln-fg-dim)' }}>
            <span className="font-medium">Tip: </span>{tip}
          </p>
        </div>
      ))}
      <p className="text-xs ln-text-muted pt-1">
        Click any group in the sidebar to zoom into that subset. Use the icon strip at the top to switch analysis modes without closing the sidebar.
      </p>
    </div>
  );
}

// ─── Tab: Database ────────────────────────────────────────────────────────────

function TabDatabase({ openExternal }: { openExternal: (url: string) => void }) {
  return (
    <div className="space-y-6">
      <section>
        <SectionHeader
          icon={<IconPath d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />}
          title="Connection Requirements"
        />
        <div className="space-y-1.5 text-sm ln-text-muted">
          <div className="flex items-start gap-2">
            <span className="text-xs mt-0.5 flex-shrink-0">•</span>
            <span>Requires the <strong>MSSQL extension</strong> (<code>ms-mssql.mssql</code>) — install from the VS Code Marketplace</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-xs mt-0.5 flex-shrink-0">•</span>
            <span><strong>Minimum permission:</strong> <code>VIEW DEFINITION</code> on the database</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-xs mt-0.5 flex-shrink-0">•</span>
            <span><strong>Table statistics</strong> additionally requires <code>VIEW SERVER STATE</code> at server level</span>
          </div>
        </div>
      </section>

      <section>
        <SectionHeader
          icon={<IconPath d="M5.25 14.25h13.5m-13.5 0a3 3 0 0 1-3-3m3 3a3 3 0 1 0 6 0m-6 0H3m16.5 0a3 3 0 0 0 3-3m-3 3a3 3 0 1 1-6 0m6 0h1.5m-7.5 0v-8.25m0 8.25a3 3 0 0 1-3-3V6m3 8.25H6" />}
          title="Supported Platforms"
        />
        <div className="grid grid-cols-2 gap-1.5 text-sm ln-text-muted">
          {['SQL Server 2016+', 'Azure SQL Database', 'Fabric Data Warehouse', 'Synapse Dedicated Pool', 'Synapse Serverless'].map(p => (
            <div key={p} className="flex items-center gap-1.5">
              <span className="text-xs" style={{ color: 'var(--ln-text-link)' }}>✓</span>
              <span>{p}</span>
            </div>
          ))}
        </div>
      </section>

      <section>
        <SectionHeader
          icon={<IconPath d="M3.75 3v11.25A2.25 2.25 0 0 0 6 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0 1 18 16.5h-2.25m-7.5 0h7.5m-7.5 0-1 3m8.5-3 1 3m0 0 .5 1.5m-.5-1.5h-9.5m0 0-.5 1.5m.75-9 3-3 2.148 2.148A12.061 12.061 0 0 1 16.5 7.605" />}
          title="Two-Phase Import"
        />
        <div className="space-y-1.5 text-sm ln-text-muted">
          <div className="flex items-start gap-2">
            <span className="text-xs mt-0.5 flex-shrink-0 font-semibold ln-text-link">1</span>
            <span><strong>Schema overview:</strong> lightweight scan of all schemas and object counts — select which schemas to load</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-xs mt-0.5 flex-shrink-0 font-semibold ln-text-link">2</span>
            <span><strong>Full import:</strong> loads DDL bodies and dependency edges for selected schemas only</span>
          </div>
        </div>
      </section>

      <section>
        <SectionHeader
          icon={<IconPath d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 0 1 0 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 0 1 0-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z" />}
          title="Customization & Settings"
        />
        <div className="space-y-1.5 text-sm ln-text-muted">
          <div className="flex items-start gap-2">
            <span className="text-xs mt-0.5 flex-shrink-0">•</span>
            <span>
              <strong>Custom DMV queries</strong> — <code>dmvQueriesFile</code> setting →{' '}
              <button onClick={() => openExternal('https://github.com/ChrisDevRepo/vscode_data_lineage/blob/main/docs/DMV_QUERIES.md')} className="ln-text-link hover:underline cursor-pointer">
                DMV Queries guide ↗
              </button>
            </span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-xs mt-0.5 flex-shrink-0">•</span>
            <span>
              <strong>Custom SQL parse rules</strong> — <code>parseRulesFile</code> setting →{' '}
              <button onClick={() => openExternal('https://github.com/ChrisDevRepo/vscode_data_lineage/blob/main/docs/PARSE_RULES.md')} className="ln-text-link hover:underline cursor-pointer">
                Parse Rules guide ↗
              </button>
            </span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-xs mt-0.5 flex-shrink-0">•</span>
            <span><code>maxNodes</code> — import cap for large databases (default 750)</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-xs mt-0.5 flex-shrink-0">•</span>
            <span><code>tableStatistics.enabled</code> — column profiling in the detail panel</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-xs mt-0.5 flex-shrink-0">•</span>
            <span><code>externalRefs.enabled</code> — show/hide virtual external reference nodes</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-xs mt-0.5 flex-shrink-0">•</span>
            <span><code>layout.direction</code> — left-to-right or top-to-bottom graph layout</span>
          </div>
        </div>
        <div className="mt-2 p-2 rounded text-xs ln-text-muted" style={{ background: 'var(--ln-bg-secondary)' }}>
          <strong className="ln-text">Most settings apply instantly.</strong> Import settings (<code>parseRulesFile</code>, <code>excludePatterns</code>) require reloading the data source.
        </div>
      </section>
    </div>
  );
}

// ─── Tab: AI ──────────────────────────────────────────────────────────────────

function TabAI({ openExternal }: { openExternal: (url: string) => void }) {
  return (
    <div className="space-y-4">
      <div className="rounded-xl overflow-hidden" style={{ background: 'var(--ln-bg-elevated)', border: '1px solid var(--ln-border)' }}>
        <div className="p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5 ln-text-link">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z" />
              </svg>
              <h3 className="text-base font-bold ln-text">GitHub Copilot Chat</h3>
            </div>
            <span className="text-xs font-bold px-2 py-0.5 rounded-full" style={{ background: 'var(--ln-button-secondary-bg)', color: 'var(--ln-text-link)', border: '1px solid var(--ln-border)', letterSpacing: '.05em' }}>NEW</span>
          </div>
          <p className="text-sm mb-3 ln-text-muted">
            Type <span className="font-bold font-mono ln-text-link">@lineage</span> in GitHub Copilot Chat to query your loaded graph. Answers come from your actual data — never from general knowledge.
          </p>
          <div className="rounded-lg p-3 space-y-1.5 font-mono text-xs" style={{ background: 'var(--ln-bg)', border: '1px solid var(--ln-border)' }}>
            {[
              'what schemas are loaded?',
              'find tables with Employee in the name',
              'what does HumanResources.Employee depend on?',
              'trace 3 levels upstream from Sales.SalesOrderDetail',
              'which objects have more than 10 connections?',
            ].map(q => (
              <div key={q}>
                <span className="font-bold ln-text-link">@lineage </span>
                <span className="ln-text">{q}</span>
              </div>
            ))}
          </div>
          <p className="text-xs mt-3 ln-text-muted">
            Requires GitHub Copilot extension &amp; VS Code 1.95+. Tools are inactive when no graph is loaded.
          </p>
        </div>
      </div>

      <div className="text-sm ln-text-muted space-y-1.5">
        <div className="flex items-start gap-2">
          <span className="text-xs mt-0.5 flex-shrink-0">•</span>
          <span>9 built-in tools: search objects, trace dependencies, find paths, list hubs, get DDL, and more</span>
        </div>
        <div className="flex items-start gap-2">
          <span className="text-xs mt-0.5 flex-shrink-0">•</span>
          <span>Works with any model in the Copilot chat dropdown — GPT-4o, Claude, Gemini, or local LLMs via Ollama</span>
        </div>
        <div className="flex items-start gap-2">
          <span className="text-xs mt-0.5 flex-shrink-0">•</span>
          <span>Auto-scales context limits based on model context window size</span>
        </div>
        <div className="flex items-start gap-2">
          <span className="text-xs mt-0.5 flex-shrink-0">•</span>
          <span>
            <button onClick={() => openExternal('https://github.com/ChrisDevRepo/vscode_data_lineage')} className="ln-text-link hover:underline cursor-pointer">
              View documentation and all supported tools ↗
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Help Modal ───────────────────────────────────────────────────────────────

export const HelpModal = memo(function HelpModal({ isOpen, onClose }: HelpModalProps) {
  const vscodeApi = useVsCode();
  const [tab, setTab] = useState<HelpTab>('overview');

  if (!isOpen) return null;

  const openExternal = (url: string) => vscodeApi.postMessage({ type: 'open-external', url });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 ln-modal-overlay"
      onClick={onClose}
    >
      <div
        className="rounded-xl shadow-2xl w-full max-w-2xl flex flex-col ln-modal"
        style={{ maxHeight: '85vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Fixed header */}
        <div className="flex items-center justify-between px-5 py-3 flex-shrink-0" style={{ borderBottom: '1px solid var(--ln-border)' }}>
          <div className="flex items-center gap-2">
            <img
              src={window.LOGO_URI}
              alt=""
              className="h-6 w-auto"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
            <span className="text-sm font-semibold ln-text">Data Lineage Viz</span>
            <span className="text-xs ln-text-muted opacity-60">v{__APP_VERSION__}</span>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded transition-colors ln-list-item ln-text"
            title="Close"
          >
            <CloseIcon className="w-4 h-4" />
          </button>
        </div>

        {/* Fixed tab bar */}
        <div className="flex items-center gap-0.5 px-4 py-2 flex-shrink-0" style={{ borderBottom: '1px solid var(--ln-border)' }}>
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`px-3 py-1.5 text-xs rounded transition-colors ${tab === id ? 'ln-btn-primary font-medium' : 'ln-text-muted hover:ln-list-item'}`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-6 py-5 min-h-0">
          {tab === 'overview'  && <TabOverview openExternal={openExternal} />}
          {tab === 'analysis'  && <TabAnalysis />}
          {tab === 'database'  && <TabDatabase openExternal={openExternal} />}
          {tab === 'ai'        && <TabAI openExternal={openExternal} />}
        </div>

        {/* Fixed footer */}
        <div className="flex items-center justify-between px-5 py-2.5 flex-shrink-0" style={{ borderTop: '1px solid var(--ln-border)' }}>
          <button
            onClick={() => vscodeApi.postMessage({ type: 'open-settings' })}
            className="flex items-center gap-1.5 text-xs ln-text-muted hover:underline cursor-pointer"
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-3.5 h-3.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 0 1 0 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 0 1 0-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z" />
            </svg>
            Settings
          </button>
          <div className="flex items-center gap-3 text-xs ln-text-muted">
            <button onClick={() => openExternal('https://github.com/ChrisDevRepo/vscode_data_lineage/issues')} className="ln-text-link hover:underline cursor-pointer">
              Found a bug?
            </button>
            <button onClick={() => openExternal('https://marketplace.visualstudio.com/items?itemName=datahelper-chwagner.data-lineage-viz&ssr=false#review-details')} className="ln-text-link hover:underline cursor-pointer">
              ★ Leave a review
            </button>
            <button onClick={() => openExternal('https://www.linkedin.com/in/christian-wagner-11aa8614b')} className="ln-text-link hover:underline cursor-pointer">
              LinkedIn
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});
