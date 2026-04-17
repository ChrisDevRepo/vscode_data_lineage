import { memo, useEffect, useState } from 'react';
import { Button } from './ui/Button';
import { Tooltip } from './ui/Tooltip';

/**
 * Represents the major phases of the application initialization and graph generation process.
 * - 'load': Extracting metadata from DACPAC or live database.
 * - 'parse': Building the internal graph and model structure.
 * - 'generate': Calculating layout and preparing the visual canvas.
 */
export type LoadingPhase = 'load' | 'parse' | 'generate';

/**
 * Props for the {@link VisualizingScreen} component.
 */
interface VisualizingScreenProps {
  /** The name or path of the data source currently being processed. */
  sourceName: string;
  /** The current active phase of the loading process. */
  phase: LoadingPhase;
  /** Optional real-time progress text (e.g., table count) from the extractor. */
  progressText: string | null;
  /** High-level summary stats (node/edge count) shown once parsing is complete. */
  stats: string | null;
  /** Error message to display if the process fails. */
  error: string | null;
  /** Callback to cancel the current loading operation and stop extraction. */
  onCancel: () => void;
  /** Callback to return to the project selection screen. */
  onBack: () => void;
}

const PHASES: { key: LoadingPhase; label: string }[] = [
  { key: 'load', label: 'Load' },
  { key: 'parse', label: 'Parse' },
  { key: 'generate', label: 'Generate' },
];

const PHASE_ORDER: Record<LoadingPhase, number> = { load: 0, parse: 1, generate: 2 };

type PhaseStatus = 'pending' | 'active' | 'done' | 'error';

/**
 * Determines the status of a specific loading phase based on the current active phase.
 *
 * @param rowPhase - The phase to check.
 * @param current - The currently active loading phase.
 * @param hasError - Whether an error has occurred in the process.
 * @returns The status of the phase (pending, active, done, or error).
 */
function phaseStatus(rowPhase: LoadingPhase, current: LoadingPhase, hasError: boolean): PhaseStatus {
  const rowIdx = PHASE_ORDER[rowPhase];
  const curIdx = PHASE_ORDER[current];
  if (hasError && rowIdx === curIdx) return 'error';
  if (rowIdx < curIdx) return 'done';
  if (rowIdx === curIdx) return 'active';
  return 'pending';
}

/**
 * Renders an icon representing the status of a loading phase.
 *
 * @param props - Component properties.
 * @returns A React element representing the phase icon.
 */
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

const AUTO_REDIRECT_MS = 8000;

/**
 * A full-screen progress and status indicator shown during project initialization.
 *
 * This component provides visual feedback for the multi-step process of loading
 * database metadata and generating the lineage graph. It handles real-time
 * progress updates, elapsed time tracking, and provides an automatic return-to-start
 * mechanism if an error occurs.
 *
 * @param props - Component properties.
 */
export const VisualizingScreen = memo(function VisualizingScreen({
  sourceName,
  phase,
  progressText,
  stats,
  error,
  onCancel,
  onBack,
}: VisualizingScreenProps) {
  // Elapsed seconds counter — shown when in 'load' phase with no DB progress text
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (phase !== 'load' || progressText || !!error) { setElapsed(0); return; }
    setElapsed(0);
    const interval = setInterval(() => setElapsed(s => s + 1), 1000);
    return () => clearInterval(interval);
  }, [phase, progressText, error]);

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
    <div className="min-h-screen flex items-center justify-center p-4 ln-start-screen">
      <div className="w-full max-w-md ln-panel flex flex-col" style={{ borderRadius: 6, minHeight: 280 }}>
        <div className="px-5 py-6 space-y-4 flex-1 overflow-y-auto">
          {/* Source name */}
          <Tooltip content={sourceName} asChild>
            <div className="text-sm font-medium truncate">
              {sourceName}
            </div>
          </Tooltip>

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
                      Reading file…{elapsed > 2 ? ` (${elapsed}s)` : ''}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        {footer && (
          <div className="px-5 pb-5 pt-2 ln-border-top flex-shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
});
