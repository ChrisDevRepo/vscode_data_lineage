/**
 * Pins the GraphCanvas camera and drag contracts the mount-level fix can't exercise without a full
 * React Flow harness: a pending fit no-ops once a later user gesture bumps the fit generation, the
 * canvas min zoom lets a fit contain every laid-out node, and a rebuild landing mid-drag preserves
 * the dragged node's position until drag stop. Each helper here is the exact function
 * `GraphCanvas.tsx` wires up, not a stand-in reimplementing its call sites.
 */
import { describe, expect, it, vi } from 'vitest';
import { getNodesBounds, getViewportForBounds, type Node as FlowNode } from '@xyflow/react';
import {
  applyPendingViewport,
  graphReadyForFit,
  skipFitForPendingViewport,
  canvasMinZoom,
  isUserMoveEvent,
  mergeIncomingNodesPreservingDrag,
  scheduleFit,
} from '../../../src/components/GraphCanvas';
import { MIN_CANVAS_ZOOM } from '../../../src/engine/nodeDecoration';

describe('scheduleFit — generation-guarded camera fit', () => {
  it('fires when nothing bumps the generation before schedule fires', () => {
    const generationRef = { current: 0 };
    const fire = vi.fn();
    const scheduledHolder: { run: (() => void) | null } = { run: null };
    const schedule = vi.fn((run: () => void) => { scheduledHolder.run = run; return 1; });
    const clear = vi.fn();

    scheduleFit(generationRef, fire, schedule, clear);
    scheduledHolder.run?.();

    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('a pending fit does not apply after a user move bumps the generation', () => {
    const generationRef = { current: 0 };
    const fire = vi.fn();
    const scheduledHolder: { run: (() => void) | null } = { run: null };
    const schedule = vi.fn((run: () => void) => { scheduledHolder.run = run; return 1; });
    const clear = vi.fn();

    scheduleFit(generationRef, fire, schedule, clear);
    generationRef.current++; // a user pan/zoom (onMoveStart with a real event)
    scheduledHolder.run?.();

    expect(fire).not.toHaveBeenCalled();
  });

  it('a programmatic move (no generation bump) does not cancel a pending fit', () => {
    const generationRef = { current: 0 };
    const fire = vi.fn();
    const scheduledHolder: { run: (() => void) | null } = { run: null };
    const schedule = vi.fn((run: () => void) => { scheduledHolder.run = run; return 1; });
    const clear = vi.fn();

    scheduleFit(generationRef, fire, schedule, clear);
    // A programmatic fitView/setViewport/setCenter fires onMoveStart with event === null,
    // which isUserMoveEvent rejects, so nothing should bump generationRef here.
    scheduledHolder.run?.();

    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('the returned cancel clears the scheduled callback directly', () => {
    const generationRef = { current: 0 };
    const fire = vi.fn();
    const schedule = vi.fn(() => 42);
    const clear = vi.fn();

    const cancel = scheduleFit(generationRef, fire, schedule, clear);
    cancel();

    expect(clear).toHaveBeenCalledWith(42);
  });

  it('a later fit\'s generation supersedes an earlier still-pending one', () => {
    const generationRef = { current: 0 };
    const earlierFire = vi.fn();
    const laterFire = vi.fn();
    const runs: Array<() => void> = [];
    const schedule = vi.fn((run: () => void) => { runs.push(run); return runs.length; });
    const clear = vi.fn();

    scheduleFit(generationRef, earlierFire, schedule, clear);
    scheduleFit(generationRef, laterFire, schedule, clear);
    runs.forEach((run) => run());

    expect(earlierFire).not.toHaveBeenCalled();
    expect(laterFire).toHaveBeenCalledTimes(1);
  });
});

describe('applyPendingViewport — a stored viewport never overrides a newer camera change', () => {
  it('applies when the fit generation is unchanged since the viewport was armed', () => {
    const setViewport = vi.fn();
    const applied = applyPendingViewport({ x: 1, y: 2, zoom: 1 }, 3, 3, setViewport);

    expect(applied).toBe(true);
    expect(setViewport).toHaveBeenCalledWith({ x: 1, y: 2, zoom: 1 }, { duration: 0 });
  });

  it('no-ops once a user pan/zoom bumps the fit generation in the gap before the graph data catches up', () => {
    // The restored viewport is armed at generation 3 (restoreViewSnapshot's rebuild is deferred via
    // startTransition); the user pans the still-displayed graph before flowNodes updates, bumping
    // fitGenerationRef to 4 the same way a real onMoveStart gesture would.
    const setViewport = vi.fn();
    const applied = applyPendingViewport({ x: 1, y: 2, zoom: 1 }, 4, 3, setViewport);

    expect(applied).toBe(false);
    expect(setViewport).not.toHaveBeenCalled();
  });
});

describe('isUserMoveEvent — onMoveStart gating', () => {
  it('is true for a real user gesture event — the case that must bump the fit generation', () => {
    expect(isUserMoveEvent({} as MouseEvent)).toBe(true);
  });

  it('is false for a programmatic move (event is null) — pending fits must survive it', () => {
    expect(isUserMoveEvent(null)).toBe(false);
  });
});

function flowNode(id: string, x: number, y: number, label: string): FlowNode {
  return { id, type: 'lineageNode', position: { x, y }, data: { label } };
}

describe('mergeIncomingNodesPreservingDrag — a rebuild mid-drag keeps the dragged node in place', () => {
  it('keeps the dragging node at its current (mid-drag) position and takes every other field from the incoming node', () => {
    const incoming = [
      flowNode('a', 0, 0, 'A-rebuilt'),
      flowNode('b', 100, 100, 'B-rebuilt'),
    ];
    const current = [
      flowNode('a', 999, 999, 'A-stale'),
      flowNode('b', 100, 100, 'B-stale'),
    ];

    const merged = mergeIncomingNodesPreservingDrag(incoming, current, new Set(['a']));

    const a = merged.find((n) => n.id === 'a')!;
    expect(a.position).toEqual({ x: 999, y: 999 });
    expect((a.data as { label: string }).label).toBe('A-rebuilt');

    const b = merged.find((n) => n.id === 'b')!;
    expect(b.position).toEqual({ x: 100, y: 100 });
    expect((b.data as { label: string }).label).toBe('B-rebuilt');
  });

  it('drops a dragged node that no longer exists in the incoming set rather than inventing one', () => {
    const incoming = [flowNode('b', 100, 100, 'B-rebuilt')];
    const current = [flowNode('a', 999, 999, 'A-stale'), flowNode('b', 5, 5, 'B-stale')];

    const merged = mergeIncomingNodesPreservingDrag(incoming, current, new Set(['a', 'b']));

    expect(merged.map((n) => n.id)).toEqual(['b']);
    expect(merged[0].position).toEqual({ x: 5, y: 5 });
  });

  it('returns the incoming list unchanged when nothing is dragging', () => {
    const incoming = [flowNode('a', 0, 0, 'A')];
    const merged = mergeIncomingNodesPreservingDrag(incoming, [], new Set());
    expect(merged).toBe(incoming);
  });
});

describe('canvasMinZoom — a fit is never clamped short of the laid-out graph', () => {
  const PANE_WIDTH = 1500;
  const PANE_HEIGHT = 850;
  const PADDING = 0.15;
  const NODE_WIDTH = 220;
  const NODE_HEIGHT = 80;

  /** A Dagre-LR-shaped layout: `ranks` columns, the widest holding `widestRank` stacked nodes. */
  function rankedLayout(ranks: number, widestRank: number, measured: boolean): FlowNode[] {
    const nodes: FlowNode[] = [];
    for (let rank = 0; rank < ranks; rank++) {
      const count = rank === Math.floor(ranks / 2) ? widestRank : 4;
      for (let i = 0; i < count; i++) {
        nodes.push({
          id: `n${rank}_${i}`,
          position: { x: rank * (NODE_WIDTH + 120), y: i * (NODE_HEIGHT + 30) },
          data: {},
          ...(measured ? { measured: { width: NODE_WIDTH, height: NODE_HEIGHT } } : {}),
        });
      }
    }
    return nodes;
  }

  /** Nodes of `nodes` whose real box falls outside the pane once React Flow fits them at `minZoom`. */
  function outsideAfterFit(nodes: FlowNode[], minZoom: number): string[] {
    const fitted = nodes.filter(n => !n.hidden).map(n => ({ ...n, measured: { width: NODE_WIDTH, height: NODE_HEIGHT } }));
    const { x, y, zoom } = getViewportForBounds(getNodesBounds(fitted), PANE_WIDTH, PANE_HEIGHT, minZoom, 2, PADDING);
    return fitted.filter((n) => {
      const left = n.position.x * zoom + x;
      const top = n.position.y * zoom + y;
      return left < 0 || top < 0 || left + NODE_WIDTH * zoom > PANE_WIDTH || top + NODE_HEIGHT * zoom > PANE_HEIGHT;
    }).map(n => n.id);
  }

  it('lowers the min zoom far enough that a fit of a tall ranked layout keeps every node inside the pane', () => {
    const nodes = rankedLayout(70, 800, true);
    const minZoom = canvasMinZoom(nodes, PANE_WIDTH, PANE_HEIGHT, PADDING);
    expect(minZoom).toBeLessThan(MIN_CANVAS_ZOOM);
    expect(outsideAfterFit(nodes, minZoom)).toEqual([]);
  });

  it('counts a node not yet measured by its layout position', () => {
    const nodes = rankedLayout(70, 800, false);
    expect(outsideAfterFit(nodes, canvasMinZoom(nodes, PANE_WIDTH, PANE_HEIGHT, PADDING))).toEqual([]);
  });

  it('keeps the default floor for a graph a fit contains above it', () => {
    expect(canvasMinZoom(rankedLayout(5, 10, true), PANE_WIDTH, PANE_HEIGHT, PADDING)).toBe(MIN_CANVAS_ZOOM);
  });

  it('ignores a hidden node, which no fit frames', () => {
    const nodes = [
      ...rankedLayout(5, 10, true),
      { id: 'hidden', position: { x: 0, y: 1_000_000 }, data: {}, hidden: true, measured: { width: NODE_WIDTH, height: NODE_HEIGHT } },
    ];
    expect(canvasMinZoom(nodes, PANE_WIDTH, PANE_HEIGHT, PADDING)).toBe(MIN_CANVAS_ZOOM);
  });

  it('keeps the default floor before the pane has a size', () => {
    expect(canvasMinZoom(rankedLayout(70, 800, true), 0, 0, PADDING)).toBe(MIN_CANVAS_ZOOM);
  });
});


describe('shown graph fitting waits for the requested layout', () => {
  const expected = [{ id: 'a', position: { x: 200, y: 300 }, data: {} }];
  const measured = () => expected.map(node => ({ ...node, measured: { width: 220, height: 80 } }));
  it.each(['AI preview', 'trace', 'analytics'])('%s arrival waits beyond the first frame, then fits exactly once', () => {
    const generation = { current: 0 };
    const frames: Array<() => void> = [];
    const fire = vi.fn();
    let rendered = [{ ...expected[0], position: { x: 0, y: 0 } }];
    const schedule = (run: () => void) => frames.push(run);
    scheduleFit(generation, fire, schedule, vi.fn(), () => graphReadyForFit(expected, [], rendered, []));
    frames.shift()!();
    expect(fire).not.toHaveBeenCalled();
    rendered = expected;
    frames.shift()!();
    expect(fire).not.toHaveBeenCalled();
    rendered = measured();
    frames.shift()!();
    expect(fire).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(0);
  });
  it('empty and fully hidden graphs need no node measurements', () => {
    expect(graphReadyForFit([], [], [], [])).toBe(true);
    expect(graphReadyForFit(expected.map(node => ({ ...node, hidden: true })), [], [], [])).toBe(true);
    expect(graphReadyForFit([], [], measured(), [])).toBe(false);
  });
  it('same node membership does not make the old layout ready', () => {
    const old = measured().map(node => ({ ...node, position: { x: 0, y: 0 } }));
    expect(graphReadyForFit(expected, [], old, [])).toBe(false);
    expect(graphReadyForFit(expected, [], measured(), [])).toBe(true);
  });
  it('waits for edges from the same graph, including changed directed endpoints', () => {
    const edges = [{ id: 'e', source: 'a', target: 'b' }];
    expect(graphReadyForFit(expected, edges, measured(), [])).toBe(false);
    expect(graphReadyForFit(expected, edges, measured(), [{ ...edges[0], source: 'b', target: 'a' }])).toBe(false);
    expect(graphReadyForFit(expected, edges, measured(), edges)).toBe(true);
  });
  it('a user gesture while waiting wins even when measurements arrive later', () => {
    const generation = { current: 0 }; const frames: Array<() => void> = []; const fire = vi.fn();
    let ready = false;
    scheduleFit(generation, fire, run => frames.push(run), vi.fn(), () => ready);
    frames.shift()!(); generation.current++; ready = true; frames.shift()!();
    expect(fire).not.toHaveBeenCalled(); expect(frames).toHaveLength(0);
  });
  it('cleanup cancels the latest readiness frame and stale callbacks cannot re-arm it', () => {
    const frames: Array<() => void> = []; const clear = vi.fn(); const fire = vi.fn();
    const cancel = scheduleFit({ current: 0 }, fire, run => frames.push(run), clear, () => false);
    frames.shift()!(); const waiting = frames.shift()!; cancel(); waiting();
    expect(clear).toHaveBeenCalled(); expect(fire).not.toHaveBeenCalled(); expect(frames).toHaveLength(0);
  });
  it('a repeated display supersedes an earlier pending fit for identical membership', () => {
    const frames: Array<() => void> = []; const generation = { current: 0 }; const first = vi.fn(); const second = vi.fn();
    const schedule = (run: () => void) => frames.push(run);
    scheduleFit(generation, first, schedule, vi.fn(), () => false);
    frames.shift()!();
    scheduleFit(generation, second, schedule, vi.fn(), () => true);
    frames.splice(0).forEach(run => run());
    expect(first).not.toHaveBeenCalled(); expect(second).toHaveBeenCalledTimes(1);
  });
});


describe('pending saved camera survives metadata before deferred graph arrival', () => {
  it('AI preview clearing leaves the preservation token armed until actual node data changes', () => {
    const consumed = { current: 0 }; const generation = { current: 7 };
    const setViewport = vi.fn(); const fit = vi.fn();
    // restoreViewSnapshot clears aiPreview and arms a saved viewport before its transition lands.
    if (!skipFitForPendingViewport(1, consumed, false)) scheduleFit(generation, fit, run => { run(); return 1; }, vi.fn());
    expect(consumed.current).toBe(0); expect(generation.current).toBe(7); expect(fit).not.toHaveBeenCalled();
    // The rebuilt flowNodes arrive later. This update consumes the skip, not a metadata render.
    expect(skipFitForPendingViewport(1, consumed, true)).toBe(true);
    expect(consumed.current).toBe(1);
    expect(applyPendingViewport({ x: 350, y: -90, zoom: 0.4 }, generation.current, 7, setViewport)).toBe(true);
    expect(setViewport).toHaveBeenCalledWith({ x: 350, y: -90, zoom: 0.4 }, { duration: 0 });
    expect(skipFitForPendingViewport(1, consumed, true)).toBe(false);
  });
});

describe('a deferred graph rebuild reconciles an intentional drag before any later show fit', () => {
  it('cancels pending rebuild fitting on drag stop and later frames the actual merged positions', () => {
    const incoming = [flowNode('a', 0, 0, 'rebuilt'), flowNode('b', 100, 100, 'other')];
    const dragged = [flowNode('a', 999, 888, 'old'), flowNode('b', 5, 5, 'old')];
    const merged = mergeIncomingNodesPreservingDrag(incoming, dragged, new Set(['a']));
    const measured = merged.map(node => ({ ...node, measured: { width: 220, height: 80 } }));
    const generation = { current: 1 }; const frames: Array<() => void> = []; const fire = vi.fn();
    scheduleFit(generation, fire, run => frames.push(run), vi.fn(), () => graphReadyForFit(incoming, [], measured, []));
    frames.shift()!(); // incoming layout and the intentional drag differ; the fit is still waiting
    generation.current++; // actual drag-stop handler cancels the pending rebuild fit
    frames.shift()!(); expect(fire).not.toHaveBeenCalled(); expect(frames).toHaveLength(0);
    // A later explicit view show uses the merged displayed layout, never the discarded Dagre position.
    expect(graphReadyForFit(merged, [], measured, [])).toBe(true);
    scheduleFit(generation, fire, run => frames.push(run), vi.fn(), () => graphReadyForFit(merged, [], measured, []));
    frames.shift()!(); expect(fire).toHaveBeenCalledTimes(1);
  });
});

describe('scheduleFit — bounded readiness wait', () => {
  it('stops once the frame budget is spent, and does not fit', () => {
    const generationRef = { current: 0 };
    const fire = vi.fn();
    const queue: Array<() => void> = [];
    const schedule = vi.fn((run: () => void) => { queue.push(run); return queue.length; });
    scheduleFit(generationRef, fire, schedule, () => {}, () => false, 3);
    for (let i = 0; i < 10 && queue.length; i++) queue.shift()!();
    expect(fire).not.toHaveBeenCalled();
    expect(schedule).toHaveBeenCalledTimes(4);
  });
  it('still honors cancel during the budgeted wait', () => {
    const fire = vi.fn();
    const queue: Array<() => void> = [];
    let ready = false;
    const cancel = scheduleFit({ current: 0 }, fire, run => { queue.push(run); return 1; }, () => {}, () => ready, 5);
    queue.shift()!();
    cancel();
    ready = true;
    while (queue.length) queue.shift()!();
    expect(fire).not.toHaveBeenCalled();
  });
});
