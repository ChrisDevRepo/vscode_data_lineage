import { memo, useEffect, useRef, useState } from 'react';
import { Button } from './ui/Button';
import { Tooltip } from './ui/Tooltip';
import { Spinner } from './ui/Spinner';

/**
 * Phases of initialization and graph generation: 'load' extracts metadata from the DACPAC or live
 * database, 'parse' builds the internal graph and model, 'generate' calculates layout and prepares
 * the canvas.
 */
export type LoadingPhase = 'load' | 'parse' | 'generate';

interface VisualizingScreenProps {
  sourceName: string;
  phase: LoadingPhase;
  /** Optional real-time progress text (e.g., table count) from the extractor. */
  progressText: string | null;
  /** High-level summary stats (node/edge count) shown once parsing is complete. */
  stats: string | null;
  error: string | null;
  /** Callback to cancel the current loading operation and stop extraction. */
  onCancel: () => void;
  /** Callback to return to the project selection screen. */
  onBack: () => void;
  /** Re-runs the failed load; `null` when the source has nothing to retry. */
  onRetry: (() => void) | null;
}

const PHASES: { key: LoadingPhase; label: string }[] = [
  { key: 'load', label: 'Load' },
  { key: 'parse', label: 'Parse' },
  { key: 'generate', label: 'Generate' },
];

const PHASE_ORDER: Record<LoadingPhase, number> = { load: 0, parse: 1, generate: 2 };

type PhaseStatus = 'pending' | 'active' | 'done' | 'error';

/**
 * Status of a loading phase (pending, active, done or error) given the currently active phase and
 * whether an error occurred.
 */
function phaseStatus(rowPhase: LoadingPhase, current: LoadingPhase, hasError: boolean): PhaseStatus {
  const rowIdx = PHASE_ORDER[rowPhase];
  const curIdx = PHASE_ORDER[current];
  if (hasError && rowIdx === curIdx) return 'error';
  if (rowIdx < curIdx) return 'done';
  if (rowIdx === curIdx) return 'active';
  return 'pending';
}

/** Renders the pending, active, completed, or failed state of a loading phase. */
function PhaseIcon({ status }: { status: PhaseStatus }) {
  if (status === 'done') {
    return (
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"
        className="w-4 h-4 shrink-0"
        style={{ color: 'var(--vscode-testing-iconPassed, #73c991)' }}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
      </svg>
    );
  }
  if (status === 'error') {
    return (
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"
        className="w-4 h-4 shrink-0"
        style={{ color: 'var(--vscode-editorError-foreground, #f14c4c)' }}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    );
  }
  if (status === 'active') {
    return <Spinner className="w-4 h-4 shrink-0" />;
  }
  return (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"
      className="w-4 h-4 shrink-0"
      style={{ color: 'var(--ln-fg-dim)' }}>
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

const COUNTDOWN_MS = 8000;
/** Automatic retries per visit; a login that keeps failing is not repeated every countdown. */
const AUTO_RETRY_MAX = 1;
/** User-facing failure strings (Microsoft style: what happened, the next step, no blame). */
const RETRY_LABEL = 'Retry';
const CANCEL_LABEL = 'Cancel';
const retryingIn = (seconds: number) => `Couldn't connect yet. Trying again in ${seconds} s.`;
const returningIn = (seconds: number) => `Auto-returning in ${seconds}s`;

/** Displays project-loading progress, elapsed time, cancellation, and failure recovery. */
export const VisualizingScreen = memo(function VisualizingScreen({
  sourceName,
  phase,
  progressText,
  stats,
  error,
  onCancel,
  onBack,
  onRetry,
}: VisualizingScreenProps) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (phase !== 'load' || !!error) { setElapsed(0); return; }
    setElapsed(0);
    const interval = setInterval(() => setElapsed(s => s + 1), 1000);
    return () => clearInterval(interval);
  }, [phase, error]);

  const [countdown, setCountdown] = useState<number | null>(null);
  const autoRetries = useRef(0);
  const willRetry = onRetry !== null && autoRetries.current < AUTO_RETRY_MAX;

  useEffect(() => {
    if (!error) { setCountdown(null); return; }

    setCountdown(Math.ceil(COUNTDOWN_MS / 1000));
    const start = Date.now();

    const tick = setInterval(() => {
      const remaining = COUNTDOWN_MS - (Date.now() - start);
      if (remaining <= 0) {
        clearInterval(tick);
        setCountdown(0);
        if (onRetry && autoRetries.current < AUTO_RETRY_MAX) {
          autoRetries.current += 1;
          onRetry();
        } else {
          onBack();
        }
      } else {
        setCountdown(Math.ceil(remaining / 1000));
      }
    }, 250);

    return () => clearInterval(tick);
  }, [error, onBack, onRetry]);

  const hasError = !!error;
  const showCancel = phase === 'load' && !hasError;

  const footer = hasError ? (
    <div className="flex items-center gap-4 w-full">
      {onRetry && <Button variant="primary" onClick={onRetry}>{RETRY_LABEL}</Button>}
      <Button variant="secondary" onClick={onCancel}>{CANCEL_LABEL}</Button>
      {countdown !== null && countdown > 0 && (
        <span className="text-xs" style={{ color: 'var(--ln-wizard-fg-muted)' }}>
          {willRetry ? retryingIn(countdown) : returningIn(countdown)}
        </span>
      )}
    </div>
  ) : showCancel ? (
    <Button variant="ghost" onClick={onCancel}>{CANCEL_LABEL}</Button>
  ) : (
    <span />
  );

  return (
    <div className="min-h-screen flex items-center justify-center p-4 ln-start-screen">
      <div className="w-full max-w-md ln-panel flex flex-col" style={{ borderRadius: 6, minHeight: 280 }}>
        <div className="px-5 py-6 space-y-4 flex-1 overflow-y-auto">
          <Tooltip content={sourceName} asChild>
            <div className="text-sm font-medium truncate">
              {sourceName}
            </div>
          </Tooltip>

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
                          ? 'var(--ln-wizard-fg-muted)'
                          : 'inherit',
                      }}
                    >
                      {label}
                    </span>
                    {isDone && key === 'parse' && stats && (
                      <span className="text-xs ml-1" style={{ color: 'var(--ln-wizard-fg-muted)' }}>
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
                          : 'var(--ln-wizard-fg-muted)',
                      }}
                    >
                      {subText}
                      {isActive && key === 'load' && progressText && elapsed > 2 ? ` (${elapsed}s)` : ''}
                    </div>
                  )}
                  {isActive && key === 'load' && !progressText && (
                    <div className="text-xs mt-1 ml-7" style={{ color: 'var(--ln-wizard-fg-muted)' }}>
                      Reading file…{elapsed > 2 ? ` (${elapsed}s)` : ''}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        {footer && (
          <div className="px-5 pb-5 pt-2 ln-border-top shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
});
