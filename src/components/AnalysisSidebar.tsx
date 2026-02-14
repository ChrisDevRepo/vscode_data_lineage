import { memo, useCallback } from 'react';
import type { AnalysisMode, AnalysisType, AnalysisGroup } from '../engine/types';
import { SidePanel } from './SidePanel';

interface AnalysisSidebarProps {
  analysis: AnalysisMode;
  onSelectGroup: (groupId: string) => void;
  onClearGroup: () => void;
  onClose: () => void;
}

const TYPE_INFO: Record<AnalysisType, { title: string; icon: string; description: string }> = {
  islands: {
    title: 'Islands',
    icon: 'M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5', // bars icon
    description: 'Disconnected subgraphs that share no edges with each other.',
  },
  hubs: {
    title: 'Hubs',
    icon: 'M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z', // sun/hub icon
    description: 'Nodes with the highest number of connections (degree).',
  },
  orphans: {
    title: 'Orphan Nodes',
    icon: 'M18.364 18.364A9 9 0 0 0 5.636 5.636m12.728 12.728A9 9 0 0 1 5.636 5.636m12.728 12.728L5.636 5.636', // circle with slash
    description: 'Nodes with no connections — zero edges in or out.',
  },
};

export const AnalysisSidebar = memo(function AnalysisSidebar({
  analysis,
  onSelectGroup,
  onClearGroup,
  onClose,
}: AnalysisSidebarProps) {
  const info = TYPE_INFO[analysis.type];
  const { result, activeGroupId } = analysis;

  const handleGroupClick = useCallback(
    (groupId: string) => {
      if (activeGroupId === groupId) {
        onClearGroup();
      } else {
        onSelectGroup(groupId);
      }
    },
    [activeGroupId, onSelectGroup, onClearGroup]
  );

  const icon = (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4" style={{ color: 'var(--ln-sidebar-header-fg)' }}>
      <path strokeLinecap="round" strokeLinejoin="round" d={info.icon} />
    </svg>
  );

  return (
    <SidePanel title={info.title} icon={icon} onClose={onClose}>
      {/* Description */}
      <div className="px-3 py-2 text-[11px]" style={{ color: 'var(--ln-fg-muted)', borderBottom: '1px solid var(--ln-border-light)' }}>
        {info.description}
      </div>

      {/* Summary */}
      <div className="px-3 py-1.5 text-xs font-medium" style={{ color: 'var(--ln-fg)' }}>
        {result.summary}
      </div>

      {/* Groups list */}
      <div className="ln-analysis-groups">
        {result.groups.length === 0 ? (
          <div className="px-3 py-4 text-xs text-center" style={{ color: 'var(--ln-fg-muted)' }}>
            None found.
          </div>
        ) : (
          result.groups.map((group) => (
            <AnalysisGroupItem
              key={group.id}
              group={group}
              analysisType={analysis.type}
              isActive={activeGroupId === group.id}
              onClick={() => handleGroupClick(group.id)}
            />
          ))
        )}
      </div>

      {/* Active filter indicator */}
      {activeGroupId && (
        <div className="px-3 py-2 text-[11px] border-t flex items-center justify-between" style={{ color: 'var(--ln-fg-muted)', borderColor: 'var(--ln-border-light)' }}>
          <span>Viewing subset</span>
          <button
            onClick={onClearGroup}
            className="text-[11px] px-1.5 py-0.5 rounded hover:opacity-80"
            style={{ color: 'var(--ln-text-link)' }}
          >
            Show all
          </button>
        </div>
      )}
    </SidePanel>
  );
});

// ─── Individual Group Item ──────────────────────────────────────────────────

interface AnalysisGroupItemProps {
  group: AnalysisGroup;
  analysisType: AnalysisType;
  isActive: boolean;
  onClick: () => void;
}

const AnalysisGroupItem = memo(function AnalysisGroupItem({
  group,
  analysisType,
  isActive,
  onClick,
}: AnalysisGroupItemProps) {
  return (
    <div
      className={`ln-analysis-group-item ${isActive ? 'ln-analysis-group-active' : ''}`}
      onClick={onClick}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium truncate" style={{ color: 'var(--ln-fg)' }}>
          {group.label}
        </span>
        <span className="text-[11px] ml-2 flex-shrink-0" style={{ color: 'var(--ln-fg-muted)' }}>
          {group.nodeIds.length} node{group.nodeIds.length !== 1 ? 's' : ''}
        </span>
      </div>
      {group.meta && (
        <div className="text-[11px] mt-0.5" style={{ color: 'var(--ln-fg-muted)' }}>
          {renderMeta(group.meta, analysisType)}
        </div>
      )}
    </div>
  );
});

function renderMeta(meta: Record<string, string | number>, type: AnalysisType): string {
  switch (type) {
    case 'islands':
      return `Schemas: ${meta.schemas}`;
    case 'hubs':
      return `${meta.type} — in: ${meta.inDegree}, out: ${meta.outDegree}`;
    case 'orphans':
      return `${meta.count} ${meta.type}${Number(meta.count) !== 1 ? 's' : ''}`;
  }
}
