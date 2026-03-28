import { memo, useState } from 'react';
import { useVsCode } from '../contexts/VsCodeContext';
import { CloseIcon } from './ui/CloseIcon';
import { Tooltip } from './ui/Tooltip';

interface HelpModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type HelpTab = 'overview' | 'analysis' | 'database' | 'ai';

const TABS: Array<{ id: HelpTab; label: string }> = [
  { id: 'overview', label: 'Overview'    },
  { id: 'analysis', label: 'Analysis'    },
  { id: 'database', label: 'Database'    },
  { id: 'ai',       label: '@lineage AI' },
];

const ICON_SIZE: Record<number, string> = { 3: 'w-3 h-3', 4: 'w-4 h-4' };

function IconPath({ d, size = 4 }: { d: string; size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className={`${ICON_SIZE[size] ?? 'w-4 h-4'} flex-shrink-0 ln-text-muted`}>
      <path strokeLinecap="round" strokeLinejoin="round" d={d} />
    </svg>
  );
}

function SectionHeader({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      {icon}
      <h3 className="text-sm font-semibold ln-text">{title}</h3>
    </div>
  );
}

function ExtLink({ url, openExternal, children }: {
  url: string;
  openExternal: (url: string) => void;
  children: React.ReactNode;
}) {
  return (
    <a href="#" role="link" onClick={(e) => { e.preventDefault(); openExternal(url); }} className="ln-text-link hover:underline cursor-pointer">
      {children}
    </a>
  );
}

// ─── Feature Card ────────────────────────────────────────────────────────────

function FeatureCard({ icon, title, desc }: { icon: string; title: string; desc: string }) {
  return (
    <div className="rounded-lg p-3 ln-help-analysis-card">
      <div className="flex items-center gap-2 mb-1">
        <IconPath d={icon} />
        <span className="text-sm font-semibold ln-text">{title}</span>
      </div>
      <p className="text-xs ln-text-muted">{desc}</p>
    </div>
  );
}

// ─── Tab: Overview ────────────────────────────────────────────────────────────

function TabOverview({ openExternal }: { openExternal: (url: string) => void }) {
  return (
    <div className="space-y-5">
      <section>
        <SectionHeader
          icon={<IconPath d="M12 3a1.5 1.5 0 0 0-1.5 1.5v1.5H9a1.5 1.5 0 0 0 0 3h1.5V12a1.5 1.5 0 0 0 3 0V9H15a1.5 1.5 0 0 0 0-3h-1.5V4.5A1.5 1.5 0 0 0 12 3ZM3 12a9 9 0 1 1 18 0 9 9 0 0 1-18 0Z" />}
          title="Keyboard Shortcuts"
        />
        <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm ln-text-muted">
          {[
            { key: '/',   label: 'Focus Quick Search'       },
            { key: 'F',   label: 'Fit graph to view'        },
            { key: 'Del', label: 'Exclude highlighted node' },
            { key: 'Esc', label: 'Close trace or analysis'  },
            { key: '?',   label: 'Open this Help'           },
          ].map(({ key, label }) => (
            <div key={key} className="flex items-center gap-3">
              <kbd className="px-1.5 py-0.5 text-xs font-mono rounded border ln-kbd flex-shrink-0">{key}</kbd>
              <span>{label}</span>
            </div>
          ))}
        </div>
      </section>

      <section>
        <SectionHeader
          icon={<IconPath d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6Zm9.75 0A2.25 2.25 0 0 1 15.75 3.75H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25Zm9.75 0a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25a2.25 2.25 0 0 1-2.25-2.25v-2.25Z" />}
          title="Features"
        />
        <div className="grid grid-cols-2 gap-2">
          <FeatureCard
            icon="M3.75 3v11.25A2.25 2.25 0 0 0 6 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0 1 18 16.5h-2.25m-7.5 0h7.5m-7.5 0-1 3m8.5-3 1 3m0 0 .5 1.5m-.5-1.5h-9.5m0 0-.5 1.5m.75-9 3-3 2.148 2.148A12.061 12.061 0 0 1 16.5 7.605"
            title="Schema Overview"
            desc="Auto-activates on large graphs — shows schema-level bubbles. Click to zoom into a schema."
          />
          <FeatureCard
            icon="M12 3c2.755 0 5.455.232 8.083.678.533.09.917.556.917 1.096v1.044a2.25 2.25 0 0 1-.659 1.591l-5.432 5.432a2.25 2.25 0 0 0-.659 1.591v2.927a2.25 2.25 0 0 1-1.244 2.013L9.75 21v-6.568a2.25 2.25 0 0 0-.659-1.591L3.659 7.409A2.25 2.25 0 0 1 3 5.818V4.774c0-.54.384-1.006.917-1.096A48.32 48.32 0 0 1 12 3Z"
            title="Filters & Bookmarks"
            desc="Filter by schema, object type, or exclusion patterns. Save filter states as named bookmarks."
          />
          <FeatureCard
            icon="M15.042 21.672 13.684 16.6m0 0-2.51 2.225.569-9.47 5.227 7.917-3.286-.672Zm-7.518-.267A8.25 8.25 0 1 1 20.25 10.5M8.288 14.212A5.25 5.25 0 1 1 17.25 10.5"
            title="Trace & Path"
            desc="Trace upstream/downstream dependencies or find the shortest path between two nodes."
          />
          <FeatureCard
            icon="M21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"
            title="Detail Search"
            desc="Full-text search inside SQL bodies and columns — distinct from Quick Search."
          />
          <FeatureCard
            icon="M18.364 18.364A9 9 0 0 0 5.636 5.636m12.728 12.728A9 9 0 0 1 5.636 5.636m12.728 12.728L5.636 5.636"
            title="Exclusion Rules"
            desc="Hide nodes by pattern (SQL LIKE wildcards or regex). Rules apply in real-time."
          />
          <FeatureCard
            icon="m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z"
            title="Node Details"
            desc="Right-click any node to inspect connections, DDL, unresolved references, and column metadata."
          />
          <FeatureCard
            icon="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3"
            title="Export"
            desc="Export to diagrams.net (Draw.io) with colored nodes, edges, and schema legend."
          />
          <FeatureCard
            icon="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 0 1 0 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 0 1 0-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z"
            title="Settings"
            desc="Customize layout, trace depth, analysis thresholds, and more in VS Code Settings."
          />
        </div>
      </section>

      <p className="text-xs ln-text-muted text-center">
        <ExtLink url="https://github.com/ChrisDevRepo/vscode_data_lineage/blob/main/docs/FEATURES.md" openExternal={openExternal}>Full documentation on GitHub ↗</ExtLink>
      </p>
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
        <div key={title} className="rounded-lg p-3 ln-help-analysis-card">
          <div className="flex items-center gap-2 mb-1.5">
            <IconPath d={icon} />
            <span className="text-sm font-semibold ln-text">{title}</span>
          </div>
          <p className="text-xs ln-text-muted">{desc}</p>
          <p className="text-xs ln-text-muted mt-1"><span className="font-medium ln-text">Tip:</span> {tip}</p>
        </div>
      ))}
      <p className="text-xs ln-text-muted pt-1">
        Click any group in the sidebar to zoom into that subset. Thresholds are configurable — search <code>dataLineageViz.analysis</code> in VS Code Settings.
      </p>
    </div>
  );
}

// ─── Tab: Database ────────────────────────────────────────────────────────────

function TabDatabase({ openExternal }: { openExternal: (url: string) => void }) {
  return (
    <div className="space-y-5">
      <section>
        <SectionHeader
          icon={<IconPath d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />}
          title="Import"
        />
        <p className="text-sm ln-text-muted mb-2">
          Requires the <strong>MSSQL extension</strong> and <code>VIEW DEFINITION</code> permission on the database.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg p-3 ln-help-analysis-card">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-bold ln-text-link">1</span>
              <span className="text-sm font-semibold ln-text">Schema Overview</span>
            </div>
            <p className="text-xs ln-text-muted">Lightweight scan of all schemas and object counts — select which to load.</p>
          </div>
          <div className="rounded-lg p-3 ln-help-analysis-card">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-bold ln-text-link">2</span>
              <span className="text-sm font-semibold ln-text">Full Import</span>
            </div>
            <p className="text-xs ln-text-muted">Loads DDL bodies and dependency edges for selected schemas only.</p>
          </div>
        </div>
      </section>

      <section>
        <SectionHeader
          icon={<IconPath d="M3.75 3v11.25A2.25 2.25 0 0 0 6 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0 1 18 16.5h-2.25m-7.5 0h7.5m-7.5 0-1 3m8.5-3 1 3m0 0 .5 1.5m-.5-1.5h-9.5m0 0-.5 1.5M9 11.25v1.5M12 9v3.75m3-6v6" />}
          title="Table Profiling"
        />
        <p className="text-sm ln-text-muted">
          On-demand column statistics (min, max, nulls, distinct counts, top values) via a separate database connection. Runs only on explicit click — no automatic queries. Large tables are sampled. External tables are skipped by default.
        </p>
        <p className="text-xs ln-text-muted mt-2">
          All generated SQL is logged to the Output channel (<code>View → Output → Data Lineage Viz</code>).{' '}
          <ExtLink url="https://github.com/ChrisDevRepo/vscode_data_lineage/blob/main/docs/PROFILING_PATTERNS.md" openExternal={openExternal}>Profiling patterns guide ↗</ExtLink>
        </p>
      </section>

      <section>
        <SectionHeader
          icon={<IconPath d="M5.25 14.25h13.5m-13.5 0a3 3 0 0 1-3-3m3 3a3 3 0 1 0 6 0m-6 0H3m16.5 0a3 3 0 0 0 3-3m-3 3a3 3 0 1 1-6 0m6 0h1.5m-7.5 0v-8.25m0 8.25a3 3 0 0 1-3-3V6m3 8.25H6" />}
          title="Platforms"
        />
        <p className="text-sm ln-text-muted">
          Tested on SQL Server 2025, Azure SQL Database, Fabric Data Warehouse, and Synapse Dedicated SQL Pool.
        </p>
      </section>

      <section>
        <SectionHeader
          icon={<IconPath d="M11.42 15.17 17.25 21A2.652 2.652 0 0 0 21 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 1 1-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 0 0 4.486-6.336l-3.276 3.277a3.004 3.004 0 0 1-2.25-2.25l3.276-3.276a4.5 4.5 0 0 0-6.336 4.486c.049.58.025 1.192-.14 1.743" />}
          title="Customization"
        />
        <div className="grid grid-cols-2 gap-2 text-xs ln-text-muted">
          <div className="rounded-lg p-2.5 ln-help-analysis-card">
            <span className="font-semibold ln-text">DMV Queries</span>
            <p className="mt-0.5">Customize the SQL used for database import.{' '}
              <ExtLink url="https://github.com/ChrisDevRepo/vscode_data_lineage/blob/main/docs/DMV_QUERIES.md" openExternal={openExternal}>Guide ↗</ExtLink>
            </p>
          </div>
          <div className="rounded-lg p-2.5 ln-help-analysis-card">
            <span className="font-semibold ln-text">Parse Rules</span>
            <p className="mt-0.5">Customize regex rules for SP dependency extraction.{' '}
              <ExtLink url="https://github.com/ChrisDevRepo/vscode_data_lineage/blob/main/docs/PARSE_RULES.md" openExternal={openExternal}>Guide ↗</ExtLink>
            </p>
          </div>
        </div>
        <p className="mt-2 text-xs ln-text-muted">
          Search <code>dataLineageViz</code> in VS Code Settings for all options including import caps, timeouts, layout, and trace depth.
        </p>
      </section>
    </div>
  );
}

// ─── Tab: AI ──────────────────────────────────────────────────────────────────

function TabAI({ openExternal }: { openExternal: (url: string) => void }) {
  return (
    <div className="space-y-4">
      <div className="rounded-lg p-4 ln-help-analysis-card">
        <div className="flex items-center gap-2 mb-3">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4 ln-text-link flex-shrink-0">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z" />
          </svg>
          <h3 className="text-sm font-semibold ln-text">GitHub Copilot Chat</h3>
          <span className="ml-auto text-xs font-bold px-2 py-0.5 rounded-full ln-help-badge">NEW</span>
        </div>
        <p className="text-sm mb-3 ln-text-muted">
          Type <span className="font-bold font-mono ln-text-link">@lineage</span> in GitHub Copilot Chat to query your loaded graph. Answers come from your actual data — never from general knowledge.
        </p>
        <div className="rounded p-3 space-y-1.5 font-mono text-xs ln-help-code-block">
          {[
            'what schemas are loaded?',
            'find tables with Employee in the name',
            'what does HumanResources.Employee depend on?',
            'trace 3 levels upstream from Sales.SalesOrderDetail',
            'which objects have more than 10 connections?',
          ].map(q => (
            <div key={q}><span className="font-bold ln-text-link">@lineage </span><span className="ln-text">{q}</span></div>
          ))}
        </div>
        <p className="text-xs mt-3 ln-text-muted">Requires GitHub Copilot extension &amp; VS Code 1.95+. Tools are inactive when no graph is loaded.</p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <FeatureCard
          icon="M11.42 15.17 17.25 21A2.652 2.652 0 0 0 21 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 1 1-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 0 0 4.486-6.336l-3.276 3.277a3.004 3.004 0 0 1-2.25-2.25l3.276-3.276a4.5 4.5 0 0 0-6.336 4.486c.049.58.025 1.192-.14 1.743"
          title="Built-in Tools"
          desc="Search objects, trace dependencies, get DDL, run analysis, and more."
        />
        <FeatureCard
          icon="M3.75 3v11.25A2.25 2.25 0 0 0 6 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0 1 18 16.5h-2.25m-7.5 0h7.5m-7.5 0-1 3m8.5-3 1 3m0 0 .5 1.5m-.5-1.5h-9.5m0 0-.5 1.5m.75-9 3-3 2.148 2.148A12.061 12.061 0 0 1 16.5 7.605"
          title="Any Model"
          desc="Works with any model in your Copilot chat dropdown. Auto-scales to context window."
        />
      </div>

      <p className="text-xs ln-text-muted">
        Disable AI features entirely via <code>ai.enabled</code> in VS Code Settings.
      </p>
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 ln-modal-overlay" onClick={onClose}>
      <div
        className="rounded-xl shadow-2xl w-full max-w-2xl flex flex-col ln-modal max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 flex-shrink-0 ln-help-sep-bottom">
          <div className="flex items-center gap-2">
            <img src={window.LOGO_URI} alt="" className="h-8 w-auto" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
            <span className="text-xs ln-text-muted opacity-60">v{__APP_VERSION__}</span>
          </div>
          <Tooltip content="Close">
            <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded transition-colors ln-list-item ln-text">
            <CloseIcon className="w-4 h-4" />
          </button>
          </Tooltip>
        </div>

        <div className="flex items-center gap-0.5 px-4 py-2 flex-shrink-0 ln-help-sep-bottom">
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

        <div className="flex-1 overflow-y-auto px-6 py-5 min-h-[420px]">
          {tab === 'overview'  && <TabOverview openExternal={openExternal} />}
          {tab === 'analysis'  && <TabAnalysis />}
          {tab === 'database'  && <TabDatabase openExternal={openExternal} />}
          {tab === 'ai'        && <TabAI openExternal={openExternal} />}
        </div>

        <div className="flex items-center justify-between px-5 py-2.5 flex-shrink-0 ln-help-sep-top">
          <button
            onClick={() => vscodeApi.postMessage({ type: 'open-settings' })}
            className="flex items-center gap-1.5 text-xs ln-text-muted hover:underline cursor-pointer"
          >
            <IconPath d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 0 1 0 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 0 1 0-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z" size={3} />
            Settings
          </button>
          <div className="flex items-center gap-3 text-xs">
            <ExtLink url="https://github.com/ChrisDevRepo/vscode_data_lineage/issues" openExternal={openExternal}>Found a bug?</ExtLink>
            <ExtLink url="https://marketplace.visualstudio.com/items?itemName=datahelper-chwagner.data-lineage-viz&ssr=false#review-details" openExternal={openExternal}>★ Leave a review</ExtLink>
            <ExtLink url="https://www.linkedin.com/in/christian-wagner-11aa8614b" openExternal={openExternal}>LinkedIn</ExtLink>
          </div>
        </div>
      </div>
    </div>
  );
});
