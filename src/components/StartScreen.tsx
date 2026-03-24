import { memo, useState } from 'react';
import { Button } from './ui/Button';
import { WizardPanel } from './ui/WizardPanel';
import type { Project } from '../engine/projectStore';

interface StartScreenProps {
  projects: Project[];
  loadingProjectId: string | null;
  startMessage: string | null;
  onCreateNew: () => void;
  onOpenProject: (id: string) => void;
  onDeleteProject: (id: string) => void;
  onDemo: () => void;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) +
      ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

export const StartScreen = memo(function StartScreen({
  projects,
  loadingProjectId,
  startMessage,
  onCreateNew,
  onOpenProject,
  onDeleteProject,
  onDemo,
}: StartScreenProps) {
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const sorted = [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return (
    <WizardPanel footer={
      <button className="text-xs hover:underline ln-text-link" onClick={onDemo}>
        Try with demo data
      </button>
    }>
      {startMessage && (
        <div className="text-xs px-3 py-2 rounded ln-status-error">{startMessage}</div>
      )}

      <Button variant="primary" className="w-full" onClick={onCreateNew}>
        + Create New Project
      </Button>

      {sorted.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <div className="flex-1 h-px" style={{ background: 'var(--ln-wizard-border)' }} />
            <span className="text-xs" style={{ color: 'var(--ln-wizard-fg)', opacity: 0.5 }}>Saved Projects</span>
            <div className="flex-1 h-px" style={{ background: 'var(--ln-wizard-border)' }} />
          </div>

          {sorted.map((project) => {
            const isLoading = loadingProjectId === project.id;
            const isConfirming = confirmDeleteId === project.id;
            const icon = project.connection.type === 'dacpac' ? '📄' : '🗄';
            const label = project.connection.type === 'dacpac' ? 'dacpac' : 'database';

            if (isConfirming) {
              return (
                <div key={project.id} className="flex items-center justify-between gap-2 px-3 py-2 rounded ln-file-picker">
                  <span className="text-sm truncate">Delete &ldquo;{project.name}&rdquo;?</span>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      className="text-xs px-2 py-1 rounded ln-list-item"
                      style={{ color: 'var(--vscode-editorError-foreground, #f14c4c)' }}
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
                  {isLoading ? <Spinner className="w-4 h-4" /> : icon}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{project.name}</div>
                  <div className="text-xs truncate" style={{ opacity: 0.55 }}>
                    {label} · {formatDate(project.updatedAt)}
                  </div>
                </div>
                {!isLoading && (
                  <Button
                    variant="icon"
                    title={`Delete "${project.name}"`}
                    style={{ width: 28, height: 28 }}
                    onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(project.id); }}
                  >
                    <IconClose />
                  </Button>
                )}
              </div>
            );
          })}
        </div>
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
