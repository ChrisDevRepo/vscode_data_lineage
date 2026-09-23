/**
 * A1 view-snapshot transition and A2 render-limit fallback/reduce-depth decisions.
 *
 * @remarks
 * Pure decision tables only — the mechanics of storing/restoring a snapshot and probing trace
 * depths live in App.tsx / useInteractiveTrace.ts; this file pins the rule each of those callers
 * defers to.
 */

import { describe, expect, it } from 'vitest';
import {
  deriveViewSnapshotTransition,
  deriveRenderLimitFallback,
  largestFittingTraceDepth,
  collapseLastExpandedSchema,
  retainExistingSchemas,
  serializeExpandedSchemas,
  traceSizeByDepth,
} from '../../../src/engine/graphDisplayMode';
import { makeGraph } from '../helpers/testUtils';

describe('deriveViewSnapshotTransition', () => {
  it('captures on the entering edge when nothing is saved yet', () => {
    expect(deriveViewSnapshotTransition(true, false, false)).toEqual({ shouldSnapshot: true, shouldRestore: false });
  });

  it('never re-captures while already locked, even across a second lock (e.g. Refresh mid-trace)', () => {
    expect(deriveViewSnapshotTransition(true, true, true)).toEqual({ shouldSnapshot: false, shouldRestore: false });
  });

  it('does not capture on the entering edge when a snapshot is already saved', () => {
    expect(deriveViewSnapshotTransition(true, false, true)).toEqual({ shouldSnapshot: false, shouldRestore: false });
  });

  it('restores on the leaving edge when a snapshot is saved', () => {
    expect(deriveViewSnapshotTransition(false, true, true)).toEqual({ shouldSnapshot: false, shouldRestore: true });
  });

  it('does nothing on the leaving edge when nothing was saved', () => {
    expect(deriveViewSnapshotTransition(false, true, false)).toEqual({ shouldSnapshot: false, shouldRestore: false });
  });

  it('does nothing while unlocked and staying unlocked', () => {
    expect(deriveViewSnapshotTransition(false, false, false)).toEqual({ shouldSnapshot: false, shouldRestore: false });
  });
});

describe('deriveRenderLimitFallback', () => {
  it('a scoped (trace/path/analysis/AI) overflow has no coarser fallback — chrome stays, actions shrink the scope', () => {
    const result = deriveRenderLimitFallback({ isScoped: true, renderedCount: 3000, renderLimit: 2000, hasSchemaOverview: true });
    expect(result.fallbackMode).toBeNull();
    expect(result.message).toContain('3,000');
    expect(result.message).toContain('2,000');
    expect(result.message.toLowerCase()).toContain('reduce');
  });

  it('an unscoped overflow falls back to Schema View when clusters exist', () => {
    const result = deriveRenderLimitFallback({ isScoped: false, renderedCount: 3000, renderLimit: 2000, hasSchemaOverview: true });
    expect(result.fallbackMode).toBe('schemaOverview');
    expect(result.message).toContain('Schema View');
  });

  it('an unscoped overflow with nothing to fall back to still returns a message and no surface', () => {
    const result = deriveRenderLimitFallback({ isScoped: false, renderedCount: 3000, renderLimit: 2000, hasSchemaOverview: false });
    expect(result.fallbackMode).toBeNull();
    expect(result.message).toContain('3,000');
  });
});

describe('largestFittingTraceDepth', () => {
  it('picks the deepest candidate that fits the render limit', () => {
    const candidates = [
      { upstream: 3, downstream: 3, count: 5000 },
      { upstream: 2, downstream: 2, count: 1800 },
      { upstream: 1, downstream: 1, count: 400 },
    ];
    expect(largestFittingTraceDepth(candidates, 2000)).toEqual({ upstream: 2, downstream: 2, count: 1800 });
  });

  it('returns null when no candidate fits', () => {
    const candidates = [{ upstream: 1, downstream: 1, count: 5000 }];
    expect(largestFittingTraceDepth(candidates, 2000)).toBeNull();
  });

  it('returns the only candidate at zero depth when it is the sole fit', () => {
    const candidates = [
      { upstream: 2, downstream: 2, count: 5000 },
      { upstream: 0, downstream: 0, count: 1 },
    ];
    expect(largestFittingTraceDepth(candidates, 2000)).toEqual({ upstream: 0, downstream: 0, count: 1 });
  });
});

describe('collapseLastExpandedSchema — Esc in Expanded Schema View steps back one schema', () => {
  it('drops only the most recently expanded schema (Set insertion order)', () => {
    const expanded = new Set(['sales', 'hr', 'finance']);
    const result = collapseLastExpandedSchema(expanded);
    expect(result).toEqual(new Set(['sales', 'hr']));
  });

  it('walking back repeatedly collapses one schema per call, never all at once', () => {
    let expanded: ReadonlySet<string> | null = new Set(['a', 'b', 'c']);
    expanded = collapseLastExpandedSchema(expanded!);
    expect([...expanded!]).toEqual(['a', 'b']);
    expanded = collapseLastExpandedSchema(expanded!);
    expect([...expanded!]).toEqual(['a']);
  });

  it('returns null once the last expanded schema is dropped', () => {
    expect(collapseLastExpandedSchema(new Set(['only']))).toBeNull();
  });

  it('is a no-op reporting null on an already-empty set', () => {
    expect(collapseLastExpandedSchema(new Set())).toBeNull();
  });
});

describe('retainExistingSchemas — settings change / Refresh keep what still exists', () => {
  it('keeps every expanded schema still present in the model', () => {
    const result = retainExistingSchemas(new Set(['sales', 'hr']), new Set(['sales', 'hr', 'finance']));
    expect(result).toEqual(new Set(['sales', 'hr']));
  });

  it('drops only the schemas no longer present, never collapsing the rest', () => {
    const result = retainExistingSchemas(new Set(['sales', 'hr', 'dropped']), new Set(['sales', 'hr']));
    expect(result).toEqual(new Set(['sales', 'hr']));
  });

  it('returns null when nothing expanded still exists', () => {
    expect(retainExistingSchemas(new Set(['gone']), new Set(['sales']))).toBeNull();
  });
});

describe('serializeExpandedSchemas — deterministic sorted output for every posted/persisted record', () => {
  it('sorts regardless of Set insertion order', () => {
    expect(serializeExpandedSchemas(new Set(['sales', 'hr', 'finance']))).toEqual(['finance', 'hr', 'sales']);
  });

  it('returns an empty array for undefined (no expanded-schema view)', () => {
    expect(serializeExpandedSchemas(undefined)).toEqual([]);
  });

  it('returns an empty array for an empty set', () => {
    expect(serializeExpandedSchemas(new Set())).toEqual([]);
  });
});

describe('traceSizeByDepth — BFS-only node count, no layout', () => {
  /** A → B → C → D, a side branch A → E, and an unreachable Z. */
  function fanOut() {
    return makeGraph(
      [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }, { id: 'E' }, { id: 'Z' }],
      [['A', 'B'], ['B', 'C'], ['C', 'D'], ['A', 'E']],
    );
  }

  it('matches traceNodeWithLevels node count for the given depths', () => {
    expect(traceSizeByDepth(fanOut(), 'A', 0, 2)).toBe(4); // A, B, C, E (E is within 2 hops too)
  });

  it('grows with downstream depth and includes the origin at depth zero', () => {
    expect(traceSizeByDepth(fanOut(), 'A', 0, 0)).toBe(1);
    expect(traceSizeByDepth(fanOut(), 'A', 0, 1)).toBe(3); // A, B, E
    expect(traceSizeByDepth(fanOut(), 'A', 0, 3)).toBe(5); // A, B, C, D, E
  });

  it('returns 0 for a node absent from the graph', () => {
    expect(traceSizeByDepth(fanOut(), 'missing', 0, 2)).toBe(0);
  });
});
