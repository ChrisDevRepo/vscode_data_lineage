import { memo, useEffect, useState } from 'react';
import { createSchemaColorMap, getSchemaColorFromMap, type SchemaColorMap } from '../utils/schemaColors';
import { schemaKey } from '../utils/sql';

interface LegendProps {
  /** A list of database schema names to display in the legend. */
  schemas: string[];
  /** Color assignments from the current loaded schema set. */
  schemaColorMap?: SchemaColorMap;
  /** True when object nodes and collapsed schema clusters are shown together. */
  isExpandedSchemaViewActive?: boolean;
  /** Schemas currently expanded into object nodes in Expanded Schema View. */
  expandedSchemas?: ReadonlySet<string>;
  /** Optional flag indicating if the main sidebar is open, used for dynamic positioning. */
  isSidebarOpen?: boolean;
}

/** The maximum number of schemas to display before showing an "expand" button. */
const SCHEMA_DISPLAY_LIMIT = 10;

/**
 * Maps rendered schemas to colors with collapsible overflow and theme-aware contrast.
 */
export const Legend = memo(function Legend({
  schemas,
  schemaColorMap,
  isExpandedSchemaViewActive = false,
  expandedSchemas,
  isSidebarOpen,
}: LegendProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [, setThemeKind] = useState(() => document.body.getAttribute('data-vscode-theme-kind') ?? '');

  /**
   * Effect to monitor VS Code theme changes.
   * Updates internal state to trigger re-renders when the theme kind attribute on document.body changes.
   */
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setThemeKind(document.body.getAttribute('data-vscode-theme-kind') ?? '');
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-vscode-theme-kind'],
    });
    return () => observer.disconnect();
  }, []);

  const colors = schemaColorMap ?? createSchemaColorMap(schemas);
  const expandedSchemaKeys = new Set(Array.from(expandedSchemas ?? [], schemaKey));

  return (
    <div
      className="absolute top-4 ln-legend rounded-md overflow-hidden z-10 transition-all duration-200"
      style={{ left: isSidebarOpen ? 'min(380px, calc(100vw - 120px))' : 16 }}
    >
      <button
        onClick={() => setCollapsed(!collapsed)}
        aria-expanded={!collapsed}
        aria-label="Toggle schema legend"
        className="w-full flex items-center justify-between px-3 py-2 transition-colors text-left ln-legend-header"
      >
        <span className="text-[10px] font-normal uppercase tracking-wider">SCHEMAS</span>
        <span className="text-[10px] opacity-70 ml-1.5">{collapsed ? '▼' : '▲'}</span>
      </button>

      {!collapsed && (
        <div className="px-3 py-2.5">
          <div>
            <div className="space-y-1.5">
              {(expanded ? schemas : schemas.slice(0, SCHEMA_DISPLAY_LIMIT))
                .filter(s => !!s && s.trim().length > 0)
                .map((schema) => {
                  const color = getSchemaColorFromMap(schema, colors);
                  const isCollapsedSchemaCluster = isExpandedSchemaViewActive && !expandedSchemaKeys.has(schemaKey(schema));
                  const schemaStateLabel = isCollapsedSchemaCluster ? 'Collapsed schema cluster' : 'Expanded schema';
                  return (
                    <div key={schema} className="flex items-center gap-2">
                      <div
                        className="w-4 h-4 rounded-sm shrink-0"
                        style={{ backgroundColor: color }}
                      />
                      <span
                        className="text-[11px] ln-text"
                        style={isCollapsedSchemaCluster ? { opacity: 0.4 } : undefined}
                        title={isExpandedSchemaViewActive ? schemaStateLabel : undefined}
                        data-schema-state={isExpandedSchemaViewActive ? (isCollapsedSchemaCluster ? 'collapsed' : 'expanded') : undefined}
                      >
                        {schema}
                      </span>
                    </div>
                  );
                })}

              {schemas.length > SCHEMA_DISPLAY_LIMIT && (
                <button
                  onClick={() => setExpanded(!expanded)}
                  className="text-[11px] ln-text-link mt-1 hover:underline cursor-pointer bg-transparent border-none p-0"
                >
                  {expanded ? 'Show less' : `+${schemas.length - SCHEMA_DISPLAY_LIMIT} more…`}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
