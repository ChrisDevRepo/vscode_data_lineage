import React, { memo, useState, useEffect } from 'react';
import { getSchemaColor } from '../utils/schemaColors';

/**
 * Props for the {@link Legend} component.
 */
interface LegendProps {
  /** A list of database schema names to display in the legend. */
  schemas: string[];
  /** Optional flag indicating if the main sidebar is open, used for dynamic positioning. */
  isSidebarOpen?: boolean;
}

/** The maximum number of schemas to display before showing an "expand" button. */
const SCHEMA_DISPLAY_LIMIT = 10;

/**
 * A floating legend component that maps database schema names to their assigned colors.
 *
 * @remarks
 * This component is memoized to prevent unnecessary re-renders during graph manipulation.
 * It features a collapsible body and an expandable list of schemas if the count exceeds {@link SCHEMA_DISPLAY_LIMIT}.
 * The component also listens for VS Code theme changes to ensure color contrast remains optimal.
 *
 * @param props - The component properties.
 * @returns A {@link React.JSX.Element} representing the schema legend.
 */
export const Legend = memo(function Legend({ schemas, isSidebarOpen }: LegendProps) {
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

  return (
    <div
      className="absolute top-4 ln-legend rounded-md overflow-hidden z-10 transition-all duration-200"
      style={{ left: isSidebarOpen ? 380 : 16 }}
    >
      <button
        onClick={() => setCollapsed(!collapsed)}
        aria-expanded={!collapsed}
        aria-label="Toggle schema legend"
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-opacity-80 transition-colors text-left ln-legend-header"
      >
        <span className="text-[10px] font-normal uppercase tracking-wider">SCHEMAS</span>
        <span className="text-[10px] opacity-70 ml-1.5">{collapsed ? '▼' : '▲'}</span>
      </button>

      {!collapsed && (
        <div className="px-3 py-2.5">
          {/* Schema Colors */}
          <div>
            <div className="space-y-1.5">
              {(expanded ? schemas : schemas.slice(0, SCHEMA_DISPLAY_LIMIT))
                .filter(s => !!s && s.trim().length > 0)
                .map((schema) => {
                  const color = getSchemaColor(schema);
                  return (
                    <div key={schema} className="flex items-center gap-2">
                      <div
                        className="w-4 h-4 rounded flex-shrink-0"
                        style={{ backgroundColor: color }}
                      />
                      <span className="text-[11px] ln-text">{schema}</span>
                    </div>
                  );
                })}
              
              {/* External Category */}
              <div className="flex items-center gap-2 mt-2 pt-2 border-t border-[var(--ln-border)] opacity-80">
                <div
                  className="w-4 h-4 rounded flex-shrink-0"
                  style={{ backgroundColor: getExternalNodeColor() }}
                />
                <span className="text-[11px] ln-text">External References</span>
              </div>

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
