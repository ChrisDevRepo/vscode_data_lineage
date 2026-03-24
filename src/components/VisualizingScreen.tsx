import { memo, useEffect, useState } from 'react';
import { Button } from './ui/Button';
import { WizardPanel } from './ui/WizardPanel';

export type LoadingPhase = 'load' | 'parse' | 'generate';

interface VisualizingScreenProps {
  sourceName: string;
  phase: LoadingPhase;
  progressText: string | null;   // db-progress sub-text (load phase)
  stats: string | null;          // "659 nodes · 1658 edges · 38 schemas" (shown on parse ✓)
  error: string | null;
  onCancel: () => void;
  onBack: () => void;
}

const PHASES: { key: LoadingPhase; label: string }[] = [
  { key: 'load', label: 'Load' },
  { key: 'parse', label: 'Parse' },
  { key: 'generate', label: 'Generate' },
];

const PHASE_ORDER: Record<LoadingPhase, number> = { load: 0, parse: 1, generate: 2 };

type PhaseStatus = 'pending' | 'active' | 'done' | 'error';

function phaseStatus(rowPhase: LoadingPhase, current: LoadingPhase, hasError: boolean): PhaseStatus {
  const rowIdx = PHASE_ORDER[rowPhase];
  const curIdx = PHASE_ORDER[current];
  if (hasError && rowIdx === curIdx) return 'error';
  if (rowIdx < curIdx) return 'done';
  if (rowIdx === curIdx) return 'active';
  return 'pending';
}

function PhaseIcon({ status }: { status: PhaseStatus }) {
  if (status === 'done') {
    return (
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"
        className="w-4 h-4 flex-shrink-0"
        style={{ color: 'var(--vscode-testing-iconPassed, #73c991)' }}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
      </svg>
    );
  }
  if (status === 'error') {
    return (
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"
        className="w-4 h-4 flex-shrink-0"
        style={{ color: 'var(--vscode-editorError-foreground, #f14c4c)' }}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    );
  }
  if (status === 'active') {
    return (
      <svg className="animate-spin w-4 h-4 flex-shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
    );
  }
  // pending
  return (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"
      className="w-4 h-4 flex-shrink-0"
      style={{ color: 'var(--ln-fg-dim)' }}>
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

const AUTO_REDIRECT_MS = 3000;

export const VisualizingScreen = memo(function VisualizingScreen({
  sourceName,
  phase,
  progressText,
  stats,
  error,
  onCancel,
  onBack,
}: VisualizingScreenProps) {
  // Countdown for auto-redirect on error — cleared on unmount to avoid loops
  const [countdown, setCountdown] = useState<number | null>(null);

  useEffect(() => {
    if (!error) { setCountdown(null); return; }

    setCountdown(Math.ceil(AUTO_REDIRECT_MS / 1000));
    const start = Date.now();

    const tick = setInterval(() => {
      const remaining = AUTO_REDIRECT_MS - (Date.now() - start);
      if (remaining <= 0) {
        clearInterval(tick);
        setCountdown(0);
        onBack();
      } else {
        setCountdown(Math.ceil(remaining / 1000));
      }
    }, 250);

    return () => clearInterval(tick);
    // onBack is stable (useCallback in App) — no re-fire risk
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);

  const hasError = !!error;
  const showCancel = phase === 'load' && !hasError;

  const footer = hasError ? (
    <div className="flex items-center gap-4 w-full">
      <Button variant="secondary" onClick={onBack}>← Back to Start</Button>
      {countdown !== null && countdown > 0 && (
        <span className="text-xs" style={{ color: 'var(--ln-fg-dim)' }}>
          Auto-returning in {countdown}s
        </span>
      )}
    </div>
  ) : showCancel ? (
    <Button variant="ghost" onClick={onCancel}>Cancel</Button>
  ) : (
    // Preserve footer area for consistent panel layout
    <span />
  );

  return (
    <WizardPanel footer={footer}>
      {/* Source name */}
      <div className="text-sm font-medium truncate" title={sourceName}>
        {sourceName}
      </div>

      {/* Phase rows */}
      <div className="space-y-3">
        {PHASES.map(({ key, label }) => {
          const status = phaseStatus(key, phase, hasError);
          const isActive = status === 'active';
          const isDone = status === 'done';
          const isError = status === 'error';

          const subText = isActive && key === 'load' && progressText
            ? progressText
            : isActive && key === 'parse'
            ? 'Building model…'
            : isActive && key === 'generate'
            ? 'Calculating layout…'
            : isDone && key === 'parse' && stats
            ? stats
            : isError && error
            ? error
            : null;

          return (
            <div key={key}>
              <div className="flex items-center gap-3">
                <PhaseIcon status={status} />
                <span
                  className="text-sm"
                  style={{
                    color: isError
                      ? 'var(--vscode-editorError-foreground, #f14c4c)'
                      : status === 'pending'
                      ? 'var(--ln-fg-dim)'
                      : 'inherit',
                  }}
                >
                  {label}
                </span>
                {isDone && key === 'parse' && stats && (
                  <span className="text-xs ml-1" style={{ color: 'var(--ln-fg-dim)' }}>
                    {stats}
                  </span>
                )}
              </div>
              {subText && key !== 'parse' && (
                <div
                  className="text-xs mt-1 ml-7"
                  style={{
                    color: isError
                      ? 'var(--vscode-editorError-foreground, #f14c4c)'
                      : 'var(--ln-fg-dim)',
                  }}
                >
                  {subText}
                </div>
              )}
              {isActive && key === 'load' && !progressText && (
                <div className="text-xs mt-1 ml-7" style={{ color: 'var(--ln-fg-dim)' }}>
                  Reading file…
                </div>
              )}
            </div>
          );
        })}
      </div>
    </WizardPanel>
  );
});
