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
import {
  buildGraphNoLayout,
  buildGraphologyGraph,
  traceNodeWithLevels,
} from '../../../src/engine/graphBuilder';
import { deriveGraphDisplayMode, deriveInitialGraphMode, traceSizeByDepth } from '../../../src/engine/graphDisplayMode';
import { filterBySchemas } from '../../../src/engine/dacpacExtractor';
import { checkObjectLimit, formatObjectLimitMessage } from '../../../src/engine/modelFilters';
import { DEFAULT_CONFIG, type DatabaseModel, type ExtensionConfig } from '../../../src/engine/types';
import { TRACE_ALL_LEVELS } from '../../../src/engine/shared/bridgeContract';
import { filterSuggestions } from '../../../src/utils/autocomplete';
import { buildLargeModel } from './largeGraphFixture';

function configWith(overrides: Partial<ExtensionConfig>): ExtensionConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

/**
 * Independently reproduces the ancestors-union-descendants reach `traceNodeWithLevels` computes at
 * unbounded depth, walking `model.neighborIndex` directly rather than through `graphology` — a
 * second implementation of the same semantics, so the assertion catches a real regression instead
 * of pinning a size that holds only for one particular fixture connectivity shape.
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

describe('graph build above the tracked fixture size', () => {
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

describe('5,000-object model: loaded and searchable, drawn only up to the render limit', () => {
  const MAX_NODES = 5000;
  const RENDER_LIMIT_MAX = 1500;
  const model = buildLargeModel(MAX_NODES);
  const config = configWith({ renderLimit: RENDER_LIMIT_MAX });

  it('admits the model at maxNodes 5000 and refuses it at 4999 with the shared message', () => {
    expect(model.nodes).toHaveLength(MAX_NODES);
    expect(checkObjectLimit(model, MAX_NODES).ok).toBe(true);

    const refused = checkObjectLimit(model, MAX_NODES - 1);
    expect(refused).toEqual({ ok: false, count: MAX_NODES, limit: MAX_NODES - 1 });
    expect(formatObjectLimitMessage(MAX_NODES, MAX_NODES - 1)).toBe(
      '5,000 objects selected (limit 4,999, set by dataLineageViz.maxNodes). Select fewer schemas or raise the setting.',
    );

    const over = buildLargeModel(MAX_NODES + 1);
    const overCheck = checkObjectLimit(over, MAX_NODES);
    expect(overCheck).toEqual({ ok: false, count: MAX_NODES + 1, limit: MAX_NODES });
    expect(formatObjectLimitMessage(MAX_NODES + 1, MAX_NODES)).toContain('5,001 objects selected (limit 5,000');
  });

  it('blocks the object surface above the render limit and starts in Schema View', () => {
    expect(deriveInitialGraphMode({ filteredCount: MAX_NODES, config })).toBe('overview');
    const state = deriveGraphDisplayMode({
      graphMode: 'full', filteredCount: MAX_NODES, config, renderLimitHit: MAX_NODES,
      expandedSchemaCount: 0, schemaOverviewRenderedCount: 12,
    });
    expect(state).toEqual({ mode: 'renderLimit', renderedCount: MAX_NODES });
  });

  it('keeps Schema View available at 5,000 objects', () => {
    const state = deriveGraphDisplayMode({
      graphMode: 'overview', filteredCount: MAX_NODES, config, renderLimitHit: MAX_NODES,
      expandedSchemaCount: 0, schemaOverviewRenderedCount: model.schemas.length,
    });
    expect(state.mode).toBe('schemaOverview');
    expect(state.renderedCount).toBe(model.schemas.length);
  });

  it('finds an object the canvas does not draw', () => {
    const target = model.nodes[MAX_NODES - 1];
    const hits = filterSuggestions(model.nodes, target.name, 50);
    expect(hits.map(n => n.id)).toContain(target.id);
    expect(model.nodes.indexOf(target)).toBeGreaterThanOrEqual(RENDER_LIMIT_MAX);
  });

  it('bounds a scoped trace by the render limit', () => {
    const graph = buildGraphologyGraph(model);
    const origin = model.nodes[MAX_NODES / 2].id;
    const reach = traceSizeByDepth(graph, origin, TRACE_ALL_LEVELS, TRACE_ALL_LEVELS);
    expect(reach).toBe(directedReach(model, origin));

    const state = deriveGraphDisplayMode({
      graphMode: 'full', filteredCount: MAX_NODES, config, renderLimitHit: MAX_NODES,
      expandedSchemaCount: 0, schemaOverviewRenderedCount: 12,
      scopedModeActive: true, scopedRenderedCount: reach,
    });
    expect(reach).toBeLessThanOrEqual(RENDER_LIMIT_MAX);
    expect(state.mode).toBe('scoped');
    expect(state.renderedCount).toBe(reach);

    const tooLarge = deriveGraphDisplayMode({
      graphMode: 'full', filteredCount: MAX_NODES, config, renderLimitHit: MAX_NODES,
      expandedSchemaCount: 0, schemaOverviewRenderedCount: 12,
      scopedModeActive: true, scopedRenderedCount: RENDER_LIMIT_MAX + 1,
    });
    expect(tooLarge.mode).toBe('renderLimit');

    const shallow = traceSizeByDepth(graph, origin, 1, 1);
    expect(shallow).toBeLessThanOrEqual(reach);
    expect(shallow).toBeLessThanOrEqual(RENDER_LIMIT_MAX);
  });
});
