// @vitest-environment jsdom
/**
 * The load-error countdown on the visualizing screen. When it ends, a saved-project load retries
 * (it does not fall back to the start view); the retry runs once per visit, so a login that keeps
 * failing cannot be hammered every few seconds, and the screen then returns to the start view with
 * the error.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VisualizingScreen } from '../../../src/components/VisualizingScreen';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COUNTDOWN_MS = 8000;
const ERROR = 'Login timed out.';

describe('VisualizingScreen countdown', () => {
  let container: HTMLDivElement;
  let root: Root;
  const onBack = vi.fn();
  const onRetry = vi.fn();
  const onCancel = vi.fn();

  const render = (error: string | null, retry: (() => void) | null = onRetry, progressText: string | null = null) => act(() => {
    root.render(
      <VisualizingScreen
        sourceName="Azure project" phase="load" progressText={progressText} stats={null}
        error={error} onCancel={onCancel} onBack={onBack} onRetry={retry}
      />,
    );
  });

  beforeEach(() => {
    vi.useFakeTimers();
    onBack.mockClear(); onRetry.mockClear(); onCancel.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('retries the load when the countdown ends and stays on the screen', () => {
    render(ERROR);
    expect(container.textContent).toContain("Couldn't connect yet. Trying again in 8 s.");
    act(() => { vi.advanceTimersByTime(COUNTDOWN_MS + 250); });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onBack).not.toHaveBeenCalled();
  });

  it('returns to the start view when the retry fails too', () => {
    render(ERROR);
    act(() => { vi.advanceTimersByTime(COUNTDOWN_MS + 250); });
    render(null);
    render(ERROR);
    expect(container.textContent).toContain('Auto-returning in 8s');
    act(() => { vi.advanceTimersByTime(COUNTDOWN_MS + 250); });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('returns to the start view when the source has nothing to retry', () => {
    render(ERROR, null);
    act(() => { vi.advanceTimersByTime(COUNTDOWN_MS + 250); });
    expect(onRetry).not.toHaveBeenCalled();
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('offers Cancel on the failure state, and the wait shows the elapsed time', () => {
    render(ERROR);
    const cancel = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Cancel');
    act(() => cancel?.click());
    expect(onCancel).toHaveBeenCalledTimes(1);
    render(null, onRetry, 'Waking up the database.');
    act(() => { vi.advanceTimersByTime(5000); });
    expect(container.textContent).toContain('Waking up the database. (5s)');
  });

  it('offers a manual Retry on the failure state only when there is something to retry', () => {
    render(ERROR);
    const retry = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Retry');
    act(() => retry?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
    render(ERROR, null);
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Retry')).toBe(false);
  });
});
