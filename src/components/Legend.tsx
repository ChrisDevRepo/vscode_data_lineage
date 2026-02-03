import { memo, useState, useEffect } from 'react';
import { getSchemaColor } from '../utils/schemaColors';

interface LegendProps {
  schemas: string[];
  isDetailSearchOpen?: boolean;
}

export const Legend = memo(function Legend({ schemas, isDetailSearchOpen }: LegendProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [, setThemeTick] = useState(0);

  // Re-render when VS Code theme changes so schema colors update
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setThemeTick(t => t + 1);
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
      style={{ left: isDetailSearchOpen ? 380 : 16 }}
    >
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-opacity-80 transition-colors text-left ln-legend-header"
      >
        <span className="text-[10px] font-normal uppercase tracking-wider">SCHEMAS</span>
        <span className="text-[8px] opacity-50 ml-1.5">{collapsed ? '▼' : '▲'}</span>
      </button>

      {!collapsed && (
        <div className="px-3 py-2.5">
          {/* Schema Colors */}
          <div>
            <div className="space-y-1.5">
              {schemas.map((schema) => {
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
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
