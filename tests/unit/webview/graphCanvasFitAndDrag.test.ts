/**
 * Pins the two GraphCanvas scheduling contracts the mount-level fix can't exercise without a full
 * React Flow harness: a pending fit no-ops once a later user gesture bumps the fit generation, and
 * a rebuild landing mid-drag preserves the dragged node's position until drag stop. Each helper here
 * is the exact function `GraphCanvas.tsx` wires up, not a stand-in reimplementing its call sites.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Node as FlowNode } from '@xyflow/react';
import {
  isUserMoveEvent,
  mergeIncomingNodesPreservingDrag,
  scheduleFit,
} from '../../../src/components/GraphCanvas';

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
