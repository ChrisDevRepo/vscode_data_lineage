/**
 * Tests for the expanded schema view partition (engine/schemaProjection).
 *
 * @remarks
 * The partition is the contract: every node lands in exactly one of `individual` or
 * `collapsed`, decided by schema membership alone. Each scenario gets its own `it` so a
 * partition defect names the case that breaks it.
 */

import { describe, expect, it } from 'vitest';
import { countExpandedSchemaViewRenderedNodes, partitionBySchema } from '../../../src/engine/schemaProjection';
import { makeGraph } from '../helpers/testUtils';

describe('partitionBySchema — expanded schemas', () => {
  // Edges are irrelevant to the partition — membership only — so each graph carries lineage
  // that would tempt a connectivity-based implementation to leak across the boundary.
  const lineageGraph = () => makeGraph(
    [
      { id: 'A', schema: 'sales' }, { id: 'B', schema: 'sales' },
      { id: 'D', schema: 'fin' }, { id: 'E', schema: 'fin' },
      { id: 'Z', schema: 'aud' },
    ],
    [['A', 'D'], ['D', 'E']],
  );

  it('shows every object of the expanded schema individually', () => {
    const result = partitionBySchema(lineageGraph(), new Set(['sales']));
    expect([...result.individual].sort()).toEqual(['A', 'B']);
  });

  it('collapses a non-expanded schema despite its lineage into the expanded one', () => {
    const result = partitionBySchema(lineageGraph(), new Set(['sales']));
    expect(result.collapsed.has('D')).toBe(true);
    expect(result.collapsed.has('E')).toBe(true);
  });

  it('collapses a schema unrelated to the expanded one', () => {
    expect(partitionBySchema(lineageGraph(), new Set(['sales'])).collapsed.has('Z')).toBe(true);
  });

  it('expands only the named schema when several carry lineage', () => {
    const result = partitionBySchema(lineageGraph(), new Set(['fin']));
    expect([...result.individual].sort()).toEqual(['D', 'E']);
    expect(result.collapsed.has('A')).toBe(true);
    expect(result.collapsed.has('Z')).toBe(true);
  });

  it('treats multiple expanded schemas as additive', () => {
    const result = partitionBySchema(lineageGraph(), new Set(['sales', 'fin']));
    expect([...result.individual].sort()).toEqual(['A', 'B', 'D', 'E']);
    expect(result.collapsed.has('Z')).toBe(true);
  });
});

describe('partitionBySchema — degenerate inputs', () => {
  it('collapses everything when no schema is expanded', () => {
    const graph = makeGraph(
      [{ id: 'A', schema: 'sales' }, { id: 'B', schema: 'fin' }],
      [['A', 'B']],
    );
    const result = partitionBySchema(graph, new Set());
    expect(result.individual.size).toBe(0);
    expect(result.collapsed.size).toBe(2);
  });

  it('contributes nothing for an expanded schema absent from the graph', () => {
    const graph = makeGraph([{ id: 'A', schema: 'sales' }, { id: 'X', schema: 'other' }], []);
    const result = partitionBySchema(graph, new Set(['ghost']));
    expect(result.individual.size).toBe(0);
    expect([...result.collapsed].sort()).toEqual(['A', 'X']);
  });
});

describe('partitionBySchema — partition invariant', () => {
  it('places every node in exactly one side', () => {
    const graph = makeGraph(
      [
        { id: 'A', schema: 's1' }, { id: 'B', schema: 's1' },
        { id: 'C', schema: 's2' }, { id: 'D', schema: 's3' },
      ],
      [['A', 'C']],
    );
    const result = partitionBySchema(graph, new Set(['s1']));

    expect(result.individual.size + result.collapsed.size).toBe(graph.order);
    expect([...result.individual].filter(id => result.collapsed.has(id))).toEqual([]);
    expect([...result.individual].sort()).toEqual(['A', 'B']);
  });
});

describe('countExpandedSchemaViewRenderedNodes', () => {
  const graph = () => makeGraph(
    [
      { id: 'A', schema: 'sales' }, { id: 'B', schema: 'sales' },
      { id: 'D', schema: 'fin' }, { id: 'Z', schema: 'aud' },
    ],
    [['A', 'D'], ['D', 'Z']],
  );

  it('counts expanded objects plus one cluster per collapsed schema', () => {
    // sales: A, B individual; fin: D individual; aud collapses to one cluster → 4.
    expect(countExpandedSchemaViewRenderedNodes(graph(), new Set(['sales', 'fin']))).toBe(4);
  });

  it('omits collapsed schema clusters when they are not rendered', () => {
    expect(countExpandedSchemaViewRenderedNodes(
      graph(),
      new Set(['sales', 'fin']),
      { includeCollapsedSchemaClusters: false },
    )).toBe(3);
  });

  it('counts one expanded object plus one collapsed cluster', () => {
    const single = makeGraph([{ id: 'A', schema: 'sales' }, { id: 'X', schema: 'other' }], []);
    expect(countExpandedSchemaViewRenderedNodes(single, new Set(['sales']))).toBe(2);
  });
});
