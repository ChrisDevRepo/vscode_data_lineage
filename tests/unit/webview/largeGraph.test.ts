// @vitest-environment jsdom
/**
 * Lanes for the graph surface above the tracked fixture size.
 *
 * Nothing above ~150 objects had ever been executed: the largest fixture is 148 nodes, while
 * `maxNodes` admits 2000 and `renderLimit` renders up to 1500. These cover the build, the
 * object-limit refusal, the render-limit boundary, and — for the scoped surface, which returns
 * before the limit check — how many nodes an unbounded trace can actually put on the canvas.
 *
 * Layout timings are printed, never asserted: they are machine-dependent and belong in the report
 * rather than in the gate.
 */

import { describe, expect, it } from 'vitest';
import type { Node as FlowNode } from '@xyflow/react';
import {
  buildGraph,
  buildGraphNoLayout,
  buildGraphologyGraph,
  traceNodeWithLevels,
} from '../../../src/engine/graphBuilder';
import { deriveGraphDisplayMode, deriveInitialGraphMode } from '../../../src/engine/graphDisplayMode';
import { filterBySchemas } from '../../../src/engine/dacpacExtractor';
import { checkObjectLimit } from '../../../src/engine/modelFilters';
import { DEFAULT_CONFIG, type DatabaseModel, type ExtensionConfig } from '../../../src/engine/types';
import { TRACE_ALL_LEVELS } from '../../../src/engine/shared/bridgeContract';
import { buildLargeModel } from './largeGraphFixture';

/**
 * The DWH generator's realistic density (hubs, hot-spot clusters, god procedures) only activates
 * once `schemaCount > 6`, i.e. roughly 300+ objects at the generator's default schema sizing — every
 * size below stays in that regime. Layout timings at these sizes are printed, not asserted, since
 * dagre's layout cost grows with edge density as well as node count.
 */
const SIZES = [500, 1000, 1500];

function configWith(overrides: Partial<ExtensionConfig>): ExtensionConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

/**
 * Independently reproduces the ancestors-union-descendants reach `traceNodeWithLevels` computes at
 * unbounded depth, walking `model.neighborIndex` directly rather than through `graphology` — a
 * second implementation of the same semantics, so the assertion catches a real regression instead
 * of pinning a size that only held under the fixture's old fully-connected shape.
 */
function directedReach(model: DatabaseModel, originId: string): number {
  const walk = (direction: 'in' | 'out'): Set<string> => {
    const visited = new Set<string>([originId]);
    const queue: string[] = [originId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const next of model.neighborIndex[current]?.[direction] ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push(next);
      }
    }
    return visited;
  };
  return new Set([...walk('in'), ...walk('out')]).size;
}

/**
 * Independently reproduces `buildFlowEdges`' reciprocal-pair collapse (a `A→B` and `B→A` pair
 * renders as one bidirectional flow edge) — the DWH generator's cycles and backward reads make
 * reciprocal pairs common, unlike the old fixture's pure-DAG stride shape, so the flow-edge count
 * legitimately drops below the model edge count whenever a reciprocal pair exists.
 */
function expectedFlowEdgeCount(model: DatabaseModel): number {
  const pairs = new Set(model.edges.map(e => `${e.source}->${e.target}`));
  const consumed = new Set<string>();
  let count = 0;
  for (const e of model.edges) {
    const fwd = `${e.source}->${e.target}`;
    if (consumed.has(fwd)) continue;
    consumed.add(fwd);
    const rev = `${e.target}->${e.source}`;
    if (pairs.has(rev)) consumed.add(rev);
    count++;
  }
  return count;
}

describe('graph build above the tracked fixture size', () => {
  it.each(SIZES)('lays out %i nodes and keeps every object and edge', (size) => {
    const model = buildLargeModel(size);
    const started = performance.now();
    const result = buildGraph(model, DEFAULT_CONFIG);
    const elapsed = Math.round(performance.now() - started);
    console.log(`buildGraph ${size} nodes / ${model.edges.length} edges: ${elapsed}ms`);

    expect(result.flowNodes).toHaveLength(size);
    expect(result.flowEdges).toHaveLength(expectedFlowEdgeCount(model));
    expect(result.graph.order).toBe(size);

    const distinct = new Set((result.flowNodes as FlowNode[]).map(n => `${n.position.x},${n.position.y}`));
    expect(distinct.size).toBeGreaterThan(size / 2);
  }, 60_000);

  it('builds without layout when the render limit blocks the object surface', () => {
    const model = buildLargeModel(2000);
    const result = buildGraphNoLayout(model, DEFAULT_CONFIG);

    expect(result.flowNodes).toHaveLength(2000);
    expect(result.graph.order).toBe(2000);
    expect(result.graph.size).toBe(model.edges.length);
  });

  it('never trims — filterBySchemas keeps every selected object, checkObjectLimit refuses over the cap', () => {
    const model = buildLargeModel(2000);
    const schemas = new Set(model.schemas.map(s => s.name));

    const filtered = filterBySchemas(model, schemas);
    expect(filtered.nodes).toHaveLength(2000);

    const ids = new Set(filtered.nodes.map(n => n.id));
    for (const edge of filtered.edges) {
      expect(ids.has(edge.source) && ids.has(edge.target)).toBe(true);
    }

    const overLimit = checkObjectLimit(filtered, 750);
    expect(overLimit).toEqual({ ok: false, count: 2000, limit: 750 });

    const withinLimit = checkObjectLimit(filtered, 2000);
    expect(withinLimit.ok).toBe(true);
  });
});

describe('render-limit boundary at scale', () => {
  it('starts a 1000-object model in Schema View', () => {
    expect(deriveInitialGraphMode({ filteredCount: 1000, config: DEFAULT_CONFIG })).toBe('overview');
  });

  it('blocks the object surface exactly at the configured limit', () => {
    const config = configWith({ renderLimit: 750 });
    const at = deriveGraphDisplayMode({
      graphMode: 'full', filteredCount: 750, config, renderLimitHit: 0,
      expandedSchemaCount: 0, schemaOverviewRenderedCount: 12,
    });
    const over = deriveGraphDisplayMode({
      graphMode: 'full', filteredCount: 751, config, renderLimitHit: 751,
      expandedSchemaCount: 0, schemaOverviewRenderedCount: 12,
    });

    expect(at.mode).toBe('full');
    expect(over.mode).toBe('renderLimit');
    expect(over.renderedCount).toBe(751);
  });

  it('keeps Schema View available for a model the object surface refuses', () => {
    const config = configWith({ renderLimit: 750 });
    const state = deriveGraphDisplayMode({
      graphMode: 'overview', filteredCount: 1000, config, renderLimitHit: 1000,
      expandedSchemaCount: 0, schemaOverviewRenderedCount: 12,
    });

    expect(state.mode).toBe('schemaOverview');
    expect(state.renderedCount).toBe(12);
  });
});

describe('scoped surface ceiling', () => {
  it('records how many nodes an all-levels trace reaches on a 1000-object model', () => {
    const model = buildLargeModel(1000);
    const graph = buildGraphologyGraph(model);
    const origin = model.nodes[500].id;

    const traced = traceNodeWithLevels(graph, origin, TRACE_ALL_LEVELS, TRACE_ALL_LEVELS);
    console.log(`all-levels trace from ${origin}: ${traced.nodeIds.size} of ${model.nodes.length} nodes`);

    const expected = directedReach(model, origin);
    expect(traced.nodeIds.size).toBe(expected);
    expect(expected).toBeGreaterThan(1);
  });

  it('bounds the scoped surface by the render limit', () => {
    const config = configWith({ renderLimit: 750 });
    const state = deriveGraphDisplayMode({
      graphMode: 'full', filteredCount: 1000, config, renderLimitHit: 1000,
      expandedSchemaCount: 0, schemaOverviewRenderedCount: 12,
      scopedModeActive: true, scopedRenderedCount: 1000,
    });

    expect(state.mode).toBe('renderLimit');
    expect(state.renderedCount).toBe(1000);
  });

  it('leaves a scope within the limit on the scoped surface', () => {
    const config = configWith({ renderLimit: 750 });
    const state = deriveGraphDisplayMode({
      graphMode: 'full', filteredCount: 1000, config, renderLimitHit: 1000,
      expandedSchemaCount: 0, schemaOverviewRenderedCount: 12,
      scopedModeActive: true, scopedRenderedCount: 40,
    });

    expect(state.mode).toBe('scoped');
    expect(state.renderedCount).toBe(40);
  });
});
