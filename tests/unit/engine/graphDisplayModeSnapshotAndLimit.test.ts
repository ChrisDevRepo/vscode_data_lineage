/**
 * A1 view-snapshot transition, A2 render-limit fallback notice, and the BFS-only trace size probe.
 *
 * @remarks
 * Pure decision tables only — the mechanics of storing/restoring a snapshot and probing trace
 * depths live in App.tsx / useInteractiveTrace.ts; this file pins the rule each of those callers
 * defers to.
 */

import { describe, expect, it } from 'vitest';
import {
  aiPreviewDisplayFilter,
  deriveViewSnapshotTransition,
  filterAfterAiPreviewDiscard,
  deriveRenderLimitFallback,
  collapseLastExpandedSchema,
  retainExistingSchemas,
  serializeExpandedSchemas,
  traceSizeByDepth,
  userFilterForHost,
  type ViewSnapshot,
} from '../../../src/engine/graphDisplayMode';
import type { FilterState } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';

describe('userFilterForHost', () => {
  const userFilter = { schemas: new Set(['dbo', 'Person']), types: new Set(['table']) } as unknown as FilterState;
  const previewFilter = { schemas: new Set(['dbo', 'Person', 'HumanResources']), types: new Set(['table', 'view']) } as unknown as FilterState;
  const snapshot: ViewSnapshot = { filter: userFilter, graphMode: 'full', expandedSchemas: [], focusNodeId: null };

  it('reports the pre-preview selection while the AI preview overrides the display filter', () => {
    expect(userFilterForHost(previewFilter, true, snapshot)).toBe(userFilter);
  });

  it('reports the live filter when no AI preview is shown', () => {
    expect(userFilterForHost(previewFilter, false, snapshot)).toBe(previewFilter);
  });

  it('reports the live filter when no snapshot was captured', () => {
    expect(userFilterForHost(previewFilter, true, null)).toBe(previewFilter);
  });
});

function userSelection(overrides: Partial<FilterState> = {}): FilterState {
  return {
    schemas: new Set(['dbo', 'Sales']),
    types: new Set(['table']),
    searchTerm: '',
    hideIsolated: true,
    focusSchemas: new Set(),
    showExternalRefs: true,
    externalRefTypes: new Set(['file', 'db']),
    exclusionPatterns: ['^tmp_'],
    ...overrides,
  } as FilterState;
}

describe('aiPreviewDisplayFilter', () => {
  const modelSchemas = ['ai', 'dbo', 'Sales'];

  it('renders every allowlisted preview node even when the user unticked its schema or hid external refs', () => {
    const selection = userSelection({ allowlistNodeIds: new Set(['[ai].[Orders]']), showExternalRefs: false, externalRefTypes: new Set() });
    const display = aiPreviewDisplayFilter(selection, true, modelSchemas);
    expect([...display.schemas].sort()).toEqual(['Sales', 'ai', 'dbo']);
    expect([...display.types].sort()).toEqual(['external', 'function', 'procedure', 'table', 'view']);
    expect(display.showExternalRefs).toBe(true);
    expect([...display.externalRefTypes].sort()).toEqual(['db', 'file']);
    expect(display.exclusionPatterns).toEqual([]);
    expect(display.hideIsolated).toBe(false);
    expect(display.allowlistNodeIds).toBe(selection.allowlistNodeIds);
  });

  it('leaves the user selection itself untouched', () => {
    const selection = userSelection({ allowlistNodeIds: new Set(['[ai].[Orders]']) });
    aiPreviewDisplayFilter(selection, true, modelSchemas);
    expect([...selection.schemas].sort()).toEqual(['Sales', 'dbo']);
    expect(selection.exclusionPatterns).toEqual(['^tmp_']);
    expect(selection.hideIsolated).toBe(true);
  });

  it('returns the selection unchanged when no AI preview is shown', () => {
    const selection = userSelection({ allowlistNodeIds: new Set(['[ai].[Orders]']) });
    expect(aiPreviewDisplayFilter(selection, false, modelSchemas)).toBe(selection);
  });

  it('returns the selection unchanged when the filter carries no allowlist', () => {
    const selection = userSelection();
    expect(aiPreviewDisplayFilter(selection, true, modelSchemas)).toBe(selection);
    const empty = userSelection({ allowlistNodeIds: new Set() });
    expect(aiPreviewDisplayFilter(empty, true, modelSchemas)).toBe(empty);
  });
});

describe('filterAfterAiPreviewDiscard', () => {
  it('drops only the preview allowlist and keeps the selection edited while the preview was shown', () => {
    const edited = userSelection({ schemas: new Set(['dbo']), allowlistNodeIds: new Set(['[ai].[Orders]']) });
    const next = filterAfterAiPreviewDiscard(edited);
    expect(next.allowlistNodeIds).toBeUndefined();
    expect([...next.schemas]).toEqual(['dbo']);
    expect([...next.types]).toEqual(['table']);
    expect(next.exclusionPatterns).toEqual(['^tmp_']);
    expect(next.hideIsolated).toBe(true);
  });
});

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
  it('names filter scope and VS Code settings and offers no action', () => {
    const result = deriveRenderLimitFallback();
    expect(result).toEqual({ message: 'Reduce filter scope or adjust VS Code settings.' });
    expect(result).not.toHaveProperty('offerSchemaView');
    expect(result.message).not.toContain('Schema View');
    expect(result.message).not.toContain('Reduce depth');
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
