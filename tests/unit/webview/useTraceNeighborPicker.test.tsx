// @vitest-environment jsdom
/**
 * The add/prune neighbor picker lists the candidates of the node's current trace controls: when
 * a trace edit changes that list, the open picker closes instead of offering stale candidates; a
 * re-render that rebuilds the controls with the same candidates keeps it open.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTraceNeighborPicker } from '../../../src/hooks/useTraceNeighborPicker';
import type { TraceNeighborOption, TraceNodeControls, TraceSideControls } from '../../../src/engine/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const option = (id: string): TraceNeighborOption => ({ id, label: id, schema: 'dbo', objectType: 'table' });

function side(add: string[]): TraceSideControls {
  return {
    add: add.map(option),
    prune: [],
    addDisabledReason: '',
    pruneDisabledReason: '',
    neighborCount: add.length,
    visibleNeighborCount: 0,
  };
}

function controls(addIn: string[], onAdd = vi.fn()): TraceNodeControls {
  return { in: side(addIn), out: side([]), onAdd, onPrune: vi.fn() };
}

type PickerApi = ReturnType<typeof useTraceNeighborPicker>;

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach(fn => fn()));

function mountPicker(initial: TraceNodeControls | undefined) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const api: { current: PickerApi | null } = { current: null };
  function Probe({ traceControls }: { traceControls: TraceNodeControls | undefined }) {
    api.current = useTraceNeighborPicker(traceControls);
    return null;
  }
  const render = (traceControls: TraceNodeControls | undefined) => act(() => root.render(<Probe traceControls={traceControls} />));
  render(initial);
  cleanups.push(() => { act(() => root.unmount()); host.remove(); });
  return { api, render };
}

describe('useTraceNeighborPicker', () => {
  it('closes the open picker when the trace edit changes its candidates', () => {
    const first = controls(['a', 'b']);
    const { api, render } = mountPicker(first);
    act(() => api.current!.applyTraceAction('add', 'in', first.in.add));
    expect(api.current!.picker?.options.map(o => o.id)).toEqual(['a', 'b']);

    render(controls(['b', 'c']));
    expect(api.current!.picker, 'stale candidates are not offered').toBeNull();
  });

  it('keeps the picker open when the controls are rebuilt with the same candidates', () => {
    const first = controls(['a', 'b']);
    const { api, render } = mountPicker(first);
    act(() => api.current!.applyTraceAction('add', 'in', first.in.add));
    const rebuilt = controls(['a', 'b']);
    render(rebuilt);
    expect(api.current!.picker?.options.map(o => o.id)).toEqual(['a', 'b']);
    act(() => api.current!.selectPickerOption(rebuilt.in.add[1]));
    expect(rebuilt.onAdd).toHaveBeenCalledWith('b');
    expect(api.current!.picker).toBeNull();
  });

  it('closes when the node loses its trace controls', () => {
    const first = controls(['a', 'b']);
    const { api, render } = mountPicker(first);
    act(() => api.current!.applyTraceAction('add', 'in', first.in.add));
    render(undefined);
    expect(api.current!.picker).toBeNull();
  });
});
