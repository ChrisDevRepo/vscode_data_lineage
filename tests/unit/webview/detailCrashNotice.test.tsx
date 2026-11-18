// @vitest-environment jsdom
/**
 * Pins that a detail-panel crash reaches the user as exactly one toast: the ErrorBoundary's `error`
 * message (the host answers it with one error toast), with no second `show-warning` from the mount.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../../src/detail/DetailApp', () => ({
  DetailApp: () => { throw new Error('detail crash'); },
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('detail panel crash', () => {
  it('posts one error message, no warning toast, and then closes the panel', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    document.body.innerHTML = '<div id="root"></div>';
    const postMessage = vi.fn();
    (window as unknown as Record<string, unknown>).__DETAIL_MODE__ = true;
    (window as unknown as Record<string, unknown>).vscode = { postMessage };
    vi.useFakeTimers({ toFake: ['setTimeout'] });

    await import('../../../src/index');
    await vi.waitFor(() => expect(postMessage.mock.calls.some(([m]) => m.type === 'error')).toBe(true), { interval: 5 });

    expect(postMessage.mock.calls.map(([m]) => m.type).filter((type) => type === 'error' || type === 'show-warning')).toEqual(['error']);

    vi.advanceTimersByTime(800);
    expect(postMessage).toHaveBeenCalledWith({ type: 'close-detail' });
  });
});
