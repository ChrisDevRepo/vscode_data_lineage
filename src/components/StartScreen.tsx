import { memo, useState, type ReactNode } from 'react';
import { Button } from './ui/Button';
import { Tooltip } from './ui/Tooltip';
import { WizardPanel } from './ui/WizardPanel';
import { StatusMessage } from './ui/StatusMessage';
import type { Project, FilterProfile } from '../engine/projectStore';

interface StartScreenProps {
  projects: Project[];
  lastOpenedId: string | null;
  initialShowProjects?: boolean;
  loadingProjectId: string | null;
  startMessage: string | null;
  onCreateNew: () => void;
  onOpenProject: (id: string) => void;
  onOpenLatest: () => void;
  onDeleteProject: (id: string) => void;
  onDeleteAllProjects: () => void;
  onDemo: () => void;
  onWizardViewChange?: (view: 'main' | 'projects') => void;
}


function schemaLine(schemas: string[]): string {
  if (schemas.length === 0) return '';
  if (schemas.length <= 3) return `Schemas: ${schemas.join(', ')}`;
  return `Schemas: ${schemas.slice(0, 3).join(', ')} +${schemas.length - 3} more`;
}

function truncatePath(path: string, maxLen = 45): string {
  if (path.length <= maxLen) return path;
  const sep = path.includes('\\') ? '\\' : '/';
  const parts = path.split(/[\\/]/);
  // Always keep at least filename + parent dir
  for (let keep = 2; keep < parts.length; keep++) {
    const tail = parts.slice(parts.length - keep).join(sep);
    if (tail.length + 4 > maxLen && keep > 2) {
      const prev = parts.slice(parts.length - (keep - 1)).join(sep);
      return `...${sep}${prev}`;
    }
  }
  return `...${sep}${parts.slice(-2).join(sep)}`;
}

function bookmarkSummary(profiles: FilterProfile[] | undefined): string | null {
  if (!profiles?.length) return null;
  const total = profiles.length;
  const aiCount = profiles.filter(p => p.source === 'ai').length;
  const traceCount = profiles.filter(p => p.source === 'trace').length;
  const analysisCount = profiles.filter(p => p.source === 'analysis').length;
  const extras: string[] = [];
  if (aiCount) extras.push(`${aiCount} AI`);
  if (traceCount) extras.push(`${traceCount} trace`);
  if (analysisCount) extras.push(`${analysisCount} analysis`);
  const label = total === 1 ? '1 saved view' : `${total} saved views`;
  return extras.length > 0 ? `${label} (${extras.join(', ')})` : label;
}

function sourceLabel(project: Project): string {
  return project.connection.type === 'dacpac' ? 'Dacpac' : 'Database';
}

function smartDetail(project: Project): string {
  if (project.connection.type === 'dacpac') return truncatePath(project.connection.path);
  const ci = project.connection.connectionInfo;
  return `${ci.database} on ${ci.server}`;
}

function projectTooltip(project: Project): ReactNode {
  const schemas = schemaLine(project.connection.schemas);
  const bm = bookmarkSummary(project.filterProfiles);
  const detail = project.connection.type === 'dacpac'
    ? truncatePath(project.connection.path, 50)
    : `${project.connection.connectionInfo.database} on ${project.connection.connectionInfo.server}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '2px 0' }}>
      <div style={{ fontWeight: 600, fontSize: 12 }}>{project.name}</div>
      <div style={{ borderTop: '1px solid var(--ln-wizard-border)', margin: '0 -4px' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
        <span style={{
          background: 'var(--ln-wizard-btn-bg)',
          borderRadius: 3,
          padding: '1px 5px',
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          flexShrink: 0,
        }}>
          {sourceLabel(project)}
        </span>
        <span style={{ opacity: 0.7 }}>{detail}</span>
      </div>
      {schemas && <div style={{ opacity: 0.55, fontSize: 11 }}>{schemas}</div>}
      {bm && <div style={{ opacity: 0.55, fontSize: 11 }}>{bm}</div>}
    </div>
  );
}

export const StartScreen = memo(function StartScreen({
  projects,
  lastOpenedId,
  initialShowProjects = false,
  loadingProjectId,
  startMessage,
  onCreateNew,
  onOpenProject,
  onOpenLatest,
  onDeleteProject,
  onDeleteAllProjects,
  onDemo,
  onWizardViewChange,
}: StartScreenProps) {
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [showProjects, setShowProjects] = useState(initialShowProjects);

  const switchView = (to: 'main' | 'projects') => {
    setShowProjects(to === 'projects');
    setConfirmDeleteAll(false);
    onWizardViewChange?.(to);
  };

  const sorted = [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const latestProject = lastOpenedId ? sorted.find(p => p.id === lastOpenedId) : undefined;

  const footer = (
    <div className="text-center">
      <button
        className="text-xs ln-text-link"
        style={{ opacity: 0.55, fontWeight: 'normal' }}
        onClick={onDemo}
      >
        Try with demo data
      </button>
    </div>
  );

  if (showProjects) {
    return (
      <WizardPanel footer={footer}>
        {/* Header */}
        <div className="flex items-center gap-2">
          <Tooltip content="Back" className="ln-tooltip--wizard">
            <button
              className="ln-list-item rounded p-1 flex-shrink-0"
              onClick={() => { switchView('main'); setConfirmDeleteId(null); }}
            >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
            </svg>
          </button>
          </Tooltip>
          <span className="text-sm font-medium flex-1">Saved Projects</span>
          <span className="text-xs mr-2" style={{ opacity: 0.45 }}>{sorted.length}</span>
          {sorted.length > 1 && !confirmDeleteAll && (
            <button
              className="text-xs ln-text-muted hover:underline"
              style={{ opacity: 0.55 }}
              onClick={() => setConfirmDeleteAll(true)}
            >
              Delete all
            </button>
          )}
          {confirmDeleteAll && (
            <div className="flex items-center gap-1.5">
              <button
                className="text-xs px-2 py-0.5 rounded ln-wizard-error-btn"
                onClick={() => { onDeleteAllProjects(); setConfirmDeleteAll(false); }}
              >
                Confirm
              </button>
              <button
                className="text-xs ln-text-muted hover:underline"
                onClick={() => setConfirmDeleteAll(false)}
              >
                Cancel
              </button>
            </div>
          )}
        </div>

        {/* Scrollable project list */}
        <div className="space-y-2 overflow-y-auto" style={{ maxHeight: '18rem' }}>
          {sorted.map((project) => {
            const isLoading = loadingProjectId === project.id;
            const isConfirming = confirmDeleteId === project.id;
            const detail = smartDetail(project);
            const schemas = schemaLine(project.connection.schemas);
            const bm = bookmarkSummary(project.filterProfiles);

            if (isConfirming) {
              return (
                <div key={project.id} className="flex items-center justify-between gap-2 px-3 py-2 rounded ln-file-picker">
                  <span className="text-sm truncate">Delete &ldquo;{project.name}&rdquo;?</span>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      className="text-xs px-2 py-1 rounded ln-list-item ln-wizard-text-error"
                      onClick={(e) => { e.stopPropagation(); onDeleteProject(project.id); setConfirmDeleteId(null); }}
                    >Delete</button>
                    <button
                      className="text-xs px-2 py-1 rounded ln-list-item"
                      onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(null); }}
                    >Cancel</button>
                  </div>
                </div>
              );
            }

            return (
              <div
                key={project.id}
                className="flex items-center gap-3 px-3 py-2 rounded cursor-pointer ln-file-picker ln-list-item"
                onClick={() => !isLoading && onOpenProject(project.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onOpenProject(project.id); }}
              >
                <span className="text-base flex-shrink-0" aria-hidden="true">
                  {isLoading ? <Spinner className="w-4 h-4" /> : (
                    <span style={{
                      background: 'var(--ln-wizard-btn-bg)',
                      borderRadius: 3,
                      padding: '1px 4px',
                      fontSize: 9,
                      textTransform: 'uppercase',
                      letterSpacing: '0.5px',
                      opacity: 0.7,
                    }}>
                      {project.connection.type === 'dacpac' ? 'DAC' : 'DB'}
                    </span>
                  )}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{project.name}</div>
                  <div className="text-xs truncate" style={{ opacity: 0.55 }}>{detail}</div>
                  {schemas && (
                    <div className="text-xs truncate" style={{ opacity: 0.40 }}>{schemas}</div>
                  )}
                  {bm && (
                    <div className="text-xs truncate" style={{ opacity: 0.40 }}>{bm}</div>
                  )}
                </div>
                {!isLoading && (
                  <Tooltip content={`Delete "${project.name}"`} className="ln-tooltip--wizard">
                    <Button
                      variant="icon"
                      style={{ width: 28, height: 28 }}
                      onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(project.id); }}
                    >
                      <IconClose />
                    </Button>
                  </Tooltip>
                )}
              </div>
            );
          })}
        </div>
      </WizardPanel>
    );
  }

  return (
    <WizardPanel footer={footer}>
      {startMessage && (
        <StatusMessage text={startMessage} type="error" />
      )}

      <Button variant="primary" className="w-full" onClick={onCreateNew}>
        + Create New Project
      </Button>

      {/* Latest quick-action — always visible, grayed when no recent project */}
      <Tooltip
        content={latestProject ? projectTooltip(latestProject) : 'No recent project'}
        maxWidth={320}
        className="ln-tooltip--wizard"
        asChild
      >
        <button
          className="w-full flex items-center gap-3 px-3 py-2 rounded text-sm text-left ln-file-picker ln-list-item"
          onClick={onOpenLatest}
          disabled={!latestProject || !!loadingProjectId}
          style={{ opacity: latestProject ? 1 : 0.45 }}
        >
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 flex-shrink-0">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
        </svg>
        <span className="truncate flex-1">
          {latestProject ? latestProject.name : 'No recent project'}
        </span>
        {loadingProjectId === latestProject?.id && <Spinner className="w-4 h-4 ml-auto flex-shrink-0" />}
      </button>
      </Tooltip>

      {/* Load Projects button — only shown when projects exist */}
      {sorted.length > 0 && (
        <button
          className="w-full flex items-center justify-between gap-3 px-3 py-2 rounded text-sm text-left ln-file-picker ln-list-item"
          onClick={() => switchView('projects')}
        >
          <div className="flex items-center gap-3">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 flex-shrink-0">
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v8.25m19.5 0A2.25 2.25 0 0 1 19.5 16.5h-15a2.25 2.25 0 0 1-2.25-2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 16.91a2.25 2.25 0 0 1-1.07-1.916V14.25" />
            </svg>
            <span>Load Projects</span>
          </div>
          <span
            className="text-xs px-1.5 py-0.5 rounded flex-shrink-0"
            style={{ background: 'var(--ln-wizard-btn-bg)', opacity: 0.8 }}
          >
            {sorted.length}
          </span>
        </button>
      )}
    </WizardPanel>
  );
});

function Spinner({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

function IconClose() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
    </svg>
  );
}
