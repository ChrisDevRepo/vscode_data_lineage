/**
 * Tests for the expanded schema view partition (engine/schemaProjection).
 */

import { describe, it } from 'vitest';
import { countExpandedSchemaViewRenderedNodes, partitionBySchema } from '../../../src/engine/schemaProjection';
import { makeGraph, assert, assertEq } from '../helpers/testUtils';

describe('Expanded Schema View Core', () => {
  it('runs all schema projection assertions', () => {

console.log('\n── Expanded Schema View Core ──');

// One expanded schema → its objects individual; every other schema collapses (rendered per schema as
// the schema-view cluster box). Edges are irrelevant to the partition — membership only.
{
  const g = makeGraph(
    [
      { id: 'A', schema: 'sales' }, { id: 'B', schema: 'sales' },
      { id: 'D', schema: 'fin' }, { id: 'E', schema: 'fin' },
      { id: 'Z', schema: 'aud' },
    ],
    [['A', 'D'], ['D', 'E']],
  );
  const r = partitionBySchema(g, new Set(['sales']));
  assert(r.individual.has('A') && r.individual.has('B'), 'expanded schema shown in full');
  assert(r.collapsed.has('D') && r.collapsed.has('E'), 'fin (not expanded) collapsed despite lineage to A');
  assert(r.collapsed.has('Z'), 'unrelated schema collapsed');
  assert(!r.individual.has('D') && !r.individual.has('Z'), 'non-expanded schemas never individual');
}

// One schema in the expanded set makes only that schema individual.
{
  const g = makeGraph(
    [
      { id: 'A', schema: 'sales' }, { id: 'D', schema: 'fin' }, { id: 'Z', schema: 'aud' },
    ],
    [['A', 'D'], ['D', 'Z']],
  );
  const r = partitionBySchema(g, new Set(['fin']));
  assert(r.individual.has('D') && !r.individual.has('A'), 'single expanded schema shows only that schema');
  assert(r.collapsed.has('A') && r.collapsed.has('Z'), 'all other schemas collapse');
}

// Multiple expanded schemas are additive.
{
  const g = makeGraph(
    [
      { id: 'A', schema: 'sales' }, { id: 'B', schema: 'sales' },
      { id: 'D', schema: 'fin' }, { id: 'Z', schema: 'aud' },
    ],
    [['A', 'D'], ['D', 'Z']],
  );
  const r = partitionBySchema(g, new Set(['sales', 'fin']));
  assert(r.individual.has('A') && r.individual.has('B') && r.individual.has('D'), 'expanded schemas are additive');
  assert(r.collapsed.has('Z'), 'schemas outside the expanded set collapse');
  assertEq(countExpandedSchemaViewRenderedNodes(g, new Set(['sales', 'fin'])), 4, 'rendered count = expanded objects + collapsed schema clusters');
  assertEq(
    countExpandedSchemaViewRenderedNodes(g, new Set(['sales', 'fin']), { includeCollapsedSchemaClusters: false }),
    3,
    'hidden schema clusters do not count as rendered nodes',
  );
}

// Empty expanded set → everything collapses (no crash).
{
  const g = makeGraph(
    [{ id: 'A', schema: 'sales' }, { id: 'B', schema: 'fin' }],
    [['A', 'B']],
  );
  const r = partitionBySchema(g, new Set());
  assertEq(r.individual.size, 0, 'nothing individual when no schema is expanded');
  assertEq(r.collapsed.size, 2, 'all nodes collapsed when no schema is expanded');
}

// A schema in the expanded set but absent from the graph contributes nothing (no crash).
{
  const g = makeGraph(
    [{ id: 'A', schema: 'sales' }, { id: 'X', schema: 'other' }],
    [],
  );
  const r = partitionBySchema(g, new Set(['ghost']));
  assertEq(r.individual.size, 0, 'absent expanded schema adds no nodes');
  assert(r.collapsed.has('A') && r.collapsed.has('X'), 'present schemas collapse when a ghost schema is expanded');
}

// Present expanded schema contributes exactly its nodes.
{
  const g = makeGraph(
    [{ id: 'A', schema: 'sales' }, { id: 'X', schema: 'other' }],
    [],
  );
  const r = partitionBySchema(g, new Set(['sales']));
  assert(r.individual.has('A'), 'present expanded schema individual');
  assert(r.collapsed.has('X'), 'other schema collapsed');
  assertEq(r.individual.size, 1, 'only the selected schema is individual');
  assertEq(countExpandedSchemaViewRenderedNodes(g, new Set(['sales'])), 2, 'one expanded object plus one collapsed schema cluster');
}

// Every node is accounted for exactly once (disjoint + full coverage).
{
  const g = makeGraph(
    [{ id: 'A', schema: 's1' }, { id: 'B', schema: 's1' }, { id: 'C', schema: 's2' }, { id: 'D', schema: 's3' }],
    [['A', 'C']],
  );
  const r = partitionBySchema(g, new Set(['s1']));
  assertEq(r.individual.size + r.collapsed.size, 4, 'partition covers every node exactly once');
  assertEq(r.individual.size, 2, 's1 has two objects individual');
}

  });
});
