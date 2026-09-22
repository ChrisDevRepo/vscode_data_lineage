// @vitest-environment jsdom
/**
 * Lanes for the graph surface above the tracked fixture size.
 *
 * Nothing above ~150 objects had ever been executed: the largest fixture is 148 nodes, while
 * `maxNodes` admits 2000 and `renderLimit` renders up to 1500. These cover the build, the schema
 * trim, the render-limit boundary, and — for the scoped surface, which returns before the limit
 * check — how many nodes an unbounded trace can actually put on the canvas.
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
import { DEFAULT_CONFIG, type ExtensionConfig } from '../../../src/engine/types';
import { TRACE_ALL_LEVELS } from '../../../src/engine/shared/bridgeContract';
import { buildLargeModel } from './largeGraphFixture';

const SIZES = [500, 1000, 1500];

function configWith(overrides: Partial<ExtensionConfig>): ExtensionConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

describe('graph build above the tracked fixture size', () => {
  it.each(SIZES)('lays out %i nodes and keeps every object and edge', (size) => {
    const model = buildLargeModel(size);
    const started = performance.now();
    const result = buildGraph(model, DEFAULT_CONFIG);
    const elapsed = Math.round(performance.now() - started);
    console.log(`buildGraph ${size} nodes / ${model.edges.length} edges: ${elapsed}ms`);

    expect(result.flowNodes).toHaveLength(size);
    expect(result.flowEdges).toHaveLength(model.edges.length);
    expect(result.graph.order).toBe(size);

    // A layout that silently degraded would stack every node on the origin.
    const distinct = new Set((result.flowNodes as FlowNode[]).map(n => `${n.position.x},${n.position.y}`));
    expect(distinct.size).toBeGreaterThan(size / 2);
    // Dagre is synchronous and takes seconds at this size — several times longer again under the
    // coverage run's instrumentation. The generous ceiling keeps that a printed number rather than
    // a machine-dependent gate failure.
  }, 120_000);

  it('builds without layout when the render limit blocks the object surface', () => {
    const model = buildLargeModel(2000);
    const result = buildGraphNoLayout(model, DEFAULT_CONFIG);

    expect(result.flowNodes).toHaveLength(2000);
    expect(result.graph.order).toBe(2000);
    expect(result.graph.size).toBe(model.edges.length);
  });

  it('trims to maxNodes rather than admitting an unbounded model', () => {
    const model = buildLargeModel(2000);
    const schemas = new Set(model.schemas.map(s => s.name));

    const trimmed = filterBySchemas(model, schemas, 750);
    expect(trimmed.nodes).toHaveLength(750);

    const ids = new Set(trimmed.nodes.map(n => n.id));
    for (const edge of trimmed.edges) {
      expect(ids.has(edge.source) && ids.has(edge.target)).toBe(true);
    }
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

    // A connected model has no structural bound below its own size: the trace reaches the whole graph.
    expect(traced.nodeIds.size).toBe(1000);
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
