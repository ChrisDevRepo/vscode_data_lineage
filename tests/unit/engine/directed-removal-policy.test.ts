// Pruning shares one fixed-leg policy across AI and GUI, including closed-anchor protection.
import { describe, expect, it } from 'vitest';
import { makeGraph } from '../helpers/testUtils';
import { analyzeRemoval, type RemovalContext } from '../../../src/engine/graphGuards';
import { canPruneTraceNode, traceRemovalSides } from '../../../src/engine/traceScope';
import { TRACE_ALL_LEVELS } from '../../../src/engine/shared/bridgeContract';

const graph = (pairs: Array<[string, string]>) => makeGraph(
  [...new Set(pairs.flat())].map(id => ({ id })), pairs,
);
function removal(pairs: Array<[string, string]>, overrides: Partial<RemovalContext> = {}) {
  const g = graph(pairs);
  return analyzeRemoval(g, {
    originId: 'A', scope: new Set(g.nodes()), removedBefore: new Set(),
    removedAfter: new Set(['C']), currentNodeId: 'C', visited: new Set(['A', 'B']),
    sides: ['downstream'], ...overrides,
  });
}
const chain: Array<[string, string]> = [['A', 'B'], ['B', 'C'], ['C', 'B'], ['C', 'D']];
const diamond: Array<[string, string]> = [['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'E'], ['B', 'X'], ['X', 'D']];

describe('shared directed removal policy', () => {
  it('cuts C’s exclusive D while retaining visited A/B in A→B↔C→D', () => {
    const result = removal(chain, { visited: new Set(['A', 'B', 'C']) });
    expect(result.rejection).toBeUndefined();
    expect(result.cutIds).toEqual(['D']);
    expect(result.disconnectedVisited).toEqual([]);
  });

  it('stops before a real shared join reached through a surviving arm', () => {
    expect(removal([...chain, ['B', 'X'], ['X', 'D']]).cutIds).toEqual([]);
  });

  it('cuts D/E after the last diamond arm leaves, even with the earlier arm already removed', () => {
    expect(removal(diamond).cutIds).toEqual([]);
    const last = removal(diamond, {
      removedBefore: new Set(['C']), removedAfter: new Set(['C', 'X']), currentNodeId: 'X',
    });
    expect(new Set(last.cutIds)).toEqual(new Set(['D', 'E']));
  });

  it.each([{ sides: ['downstream'] }, { sides: ['upstream', 'downstream'] }] as const)(
    'never treats a sideways walk as support (legs=$sides)', ({ sides }) => {
      const result = removal([['A', 'B'], ['B', 'C'], ['C', 'D'], ['A', 'X'], ['D', 'X']], { sides });
      expect(result.cutIds).toEqual(['D']);
    },
  );

  it('applies the same cut upstream while the downstream leg is closed', () => {
    const result = removal(chain.map(([a, b]) => [b, a]), { sides: ['upstream'] });
    expect(result.cutIds).toEqual(['D']);
  });

  it('stops before visited B and reports its disconnected committed analysis for rejection', () => {
    const result = removal([['A', 'C'], ['C', 'B'], ['B', 'D']]);
    expect(result.disconnectedVisited).toEqual(['B']);
    expect(result.cutIds).toEqual([]);
  });

  it('refuses removal of a visited node other than the current node', () => {
    const result = removal(chain, { removedAfter: new Set(['B']), currentNodeId: 'C' });
    expect(result.rejection).toBe('visited');
    expect(result.cutIds).toEqual([]);
  });

  it('permits the visited current node’s self-prune exception', () => {
    expect(removal(chain, { visited: new Set(['A', 'B', 'C']) }).rejection).toBeUndefined();
  });

  it('has no visited-node exception when currentNodeId is absent', () => {
    expect(removal(chain, { currentNodeId: undefined, visited: new Set(['A', 'B', 'C']) }).rejection).toBe('visited');
  });

  it('protects the origin even if it is the current node', () => {
    expect(removal(chain, { removedAfter: new Set(['A']), currentNodeId: 'A' }).rejection).toBe('origin');
  });

  it.each([
    { originId: 'missing' },
    { removedAfter: new Set(['missing']) },
  ])('fails safely for missing graph nodes (%j)', overrides => {
    expect(removal(chain, overrides).rejection).toBe('unknown-node');
  });

  it.each([
    { scope: new Set(['B', 'C']) },
    { scope: new Set(['A', 'B']) },
    { removedBefore: new Set(['X']) },
  ])('refuses an invalid scope/removal proposal (%j)', overrides => {
    expect(removal(chain, overrides).rejection).toBe('invalid-scope');
  });

  it('does not walk outside scope or across an already removed node', () => {
    expect(removal(chain, { scope: new Set(['A', 'B', 'C']) }).cutIds).toEqual([]);
    expect(removal([...chain, ['D', 'E']], {
      removedBefore: new Set(['D']), removedAfter: new Set(['C', 'D']),
    }).cutIds).toEqual([]);
  });

  it('terminates on a cycle and cuts only its newly unsupported open nodes', () => {
    expect(removal([['A', 'C'], ['C', 'D'], ['D', 'E'], ['E', 'D']]).cutIds.sort()).toEqual(['D', 'E']);
  });

  it('derives legs from actual All-level configuration and closes zero-depth sides', () => {
    expect(traceRemovalSides(0, TRACE_ALL_LEVELS)).toEqual(['downstream']);
    expect(traceRemovalSides(TRACE_ALL_LEVELS, 0)).toEqual(['upstream']);
    expect(traceRemovalSides(0, 0)).toEqual([]);
  });

  it('trace preview refuses an unknown clicked node or missing origin without throwing', () => {
    const g = graph(chain);
    expect(canPruneTraceNode(g, 'A', new Set([...g.nodes(), 'missing']), 'missing', ['downstream'])).toEqual({ safe: false, reason: 'not-visible' });
    expect(canPruneTraceNode(g, 'missing', new Set([...g.nodes(), 'missing']), 'C', ['downstream'])).toEqual({ safe: false, reason: 'origin' });
  });
});
