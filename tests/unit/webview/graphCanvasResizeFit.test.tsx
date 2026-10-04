// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyPendingViewport, scheduleFit, useCanvasResizeFit, useRebuildResumableFit } from '../../../src/components/GraphCanvas';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const dispose: (() => void)[] = [];
afterEach(() => dispose.splice(0).forEach(fn => fn()));
function renderHook<P>(hook: (props: P) => void, { initialProps }: { initialProps: P }) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let mounted = true;
  function Probe({ props }: { props: P }) { hook(props); return null; }
  const rerender = (props: P) => act(() => root.render(<Probe props={props} />));
  const unmount = () => { if (mounted) { act(() => root.unmount()); host.remove(); mounted = false; } };
  dispose.push(unmount);
  rerender(initialProps);
  return { rerender, unmount };
}

describe('canvas resize fitting', () => {
  it('a transient exit resize cannot supersede a pending saved camera restore', () => {
    const generation = { current: 20 };
    const saved = { x: 346.539, y: 27.8744, zoom: 0.00627756 };
    const setViewport = vi.fn();
    const fit = vi.fn(() => scheduleFit(generation, vi.fn(), () => 1, vi.fn()));
    const { rerender } = renderHook(({ width, restoring }) => useCanvasResizeFit(width, 629, fit, restoring),
      { initialProps: { width: 846, restoring: false } });
    rerender({ width: 846, restoring: true });
    rerender({ width: 830, restoring: true });
    rerender({ width: 846, restoring: true });
    expect(applyPendingViewport(saved, generation.current, 20, setViewport)).toBe(true);
    expect(setViewport).toHaveBeenCalledWith(saved, { duration: 0 });
    rerender({ width: 846, restoring: false });
    expect(fit).not.toHaveBeenCalled();
  });

  it('reframes a settled graph on shrink and expansion, without refitting unchanged or unavailable panes', () => {
    const cancel = vi.fn();
    const fit = vi.fn(() => cancel);
    const { rerender, unmount } = renderHook(({ width, height }) => useCanvasResizeFit(width, height, fit),
      { initialProps: { width: 1600, height: 900 } });
    expect(fit).not.toHaveBeenCalled();
    rerender({ width: 1200, height: 900 });
    expect(fit).toHaveBeenCalledTimes(1);
    rerender({ width: 1200, height: 900 });
    expect(fit).toHaveBeenCalledTimes(1);
    rerender({ width: 1200, height: 700 });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fit).toHaveBeenCalledTimes(2);
    rerender({ width: 1600, height: 900 });
    expect(fit).toHaveBeenCalledTimes(3);
    rerender({ width: 0, height: 0 });
    rerender({ width: 1600, height: 900 });
    expect(fit).toHaveBeenCalledTimes(3);
    unmount();
  });

  it('a user pan or zoom after resize supersedes its pending fit', () => {
    const generation = { current: 0 };
    const fire = vi.fn();
    const frames: (() => void)[] = [];
    const fit = () => scheduleFit(generation, fire, run => { frames.push(run); return frames.length; }, vi.fn());
    const { rerender } = renderHook(({ width }) => useCanvasResizeFit(width, 900, fit),
      { initialProps: { width: 1600 } });
    rerender({ width: 1200 });
    generation.current++;
    frames[0]();
    expect(fire).not.toHaveBeenCalled();
  });
});

describe('graph fitting after rebuilding', () => {
  function setup() {
    const generation = { current: 0 };
    const fire = vi.fn();
    const frames: (() => void)[] = [];
    const clear = vi.fn();
    let rebuilding = true;
    let measured = true;
    const arm = vi.fn(() => scheduleFit(generation, fire,
      run => { frames.push(run); return frames.length; }, clear, () => !rebuilding && measured));
    const drain = () => { while (frames.length) frames.shift()!(); };
    const view = renderHook(({ rebuilding: next, ready, request, preserve }) => {
      rebuilding = next;
      measured = ready;
      const fit = useRebuildResumableFit(next, generation, arm);
      useEffect(() => {
        if (!preserve) return fit();
      }, [fit, request, preserve]);
    }, { initialProps: { rebuilding: true, ready: true, request: 0, preserve: false } });
    return { ...view, generation, fire, arm, frames, drain, clear };
  }

  it('resumes after the spinner outlasts the frame budget and waits for measurement', () => {
    const test = setup();
    test.drain();
    expect(test.fire).not.toHaveBeenCalled();
    expect(test.frames).toHaveLength(0);
    test.rerender({ rebuilding: false, ready: false, request: 0, preserve: false });
    expect(test.arm).toHaveBeenCalledTimes(2);
    test.frames.shift()!();
    expect(test.fire).not.toHaveBeenCalled();
    test.rerender({ rebuilding: false, ready: true, request: 0, preserve: false });
    test.drain();
    expect(test.fire).toHaveBeenCalledTimes(1);
    test.rerender({ rebuilding: false, ready: true, request: 0, preserve: false });
    expect(test.arm).toHaveBeenCalledTimes(2);
  });

  it.each(['before', 'after'])('a user gesture %s rebuild completion cancels fitting', timing => {
    const test = setup();
    test.drain();
    if (timing === 'before') test.generation.current++;
    test.rerender({ rebuilding: false, ready: true, request: 0, preserve: false });
    if (timing === 'after') test.generation.current++;
    test.drain();
    expect(test.fire).not.toHaveBeenCalled();
    expect(test.arm).toHaveBeenCalledTimes(timing === 'before' ? 1 : 2);
  });

  it('resumes only the newest graph request and old cleanup does not cancel it', () => {
    const test = setup();
    test.rerender({ rebuilding: true, ready: true, request: 1, preserve: false });
    test.drain();
    test.rerender({ rebuilding: false, ready: true, request: 1, preserve: false });
    test.drain();
    expect(test.arm).toHaveBeenCalledTimes(3);
    expect(test.fire).toHaveBeenCalledTimes(1);
  });

  it('a newer camera fit supersedes rebuild resumption', () => {
    const test = setup();
    test.drain();
    const newerFit = vi.fn();
    scheduleFit(test.generation, newerFit, run => { test.frames.push(run); return 1; }, vi.fn());
    test.rerender({ rebuilding: false, ready: true, request: 0, preserve: false });
    test.drain();
    expect(test.arm).toHaveBeenCalledTimes(1);
    expect(test.fire).not.toHaveBeenCalled();
    expect(newerFit).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])('unmount cancels fitting while rebuilding=%s', rebuilding => {
    const test = setup();
    if (!rebuilding) test.rerender({ rebuilding: false, ready: true, request: 0, preserve: false });
    test.unmount();
    test.drain();
    expect(test.fire).not.toHaveBeenCalled();
    expect(test.clear).toHaveBeenCalled();
  });

  it('cleanup for a saved viewport prevents rebuild completion from rearming fitting', () => {
    const test = setup();
    test.rerender({ rebuilding: true, ready: true, request: 1, preserve: true });
    const savedGeneration = test.generation.current;
    const saved = { x: 20, y: 30, zoom: 0.5 };
    const setViewport = vi.fn();
    test.rerender({ rebuilding: false, ready: true, request: 1, preserve: true });
    test.drain();
    expect(test.arm).toHaveBeenCalledTimes(1);
    expect(test.fire).not.toHaveBeenCalled();
    expect(applyPendingViewport(saved, test.generation.current, savedGeneration, setViewport)).toBe(true);
    expect(setViewport).toHaveBeenCalledWith(saved, { duration: 0 });
  });
});
