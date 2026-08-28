/**
 * Graph construction and BFS trace traversal.
 *
 * @remarks
 * The trace is the heart of the product, so every directional rule is its own `it`: which
 * nodes a depth cap admits, and which edges survive the toward-the-origin filter, fail for
 * different reasons and must be able to fail independently.
 *
 * Split out of this file, by module under test:
 * - virtual external nodes (`buildModel`) → modelBuilder-externalRefs.test.ts
 * - schema and expanded-schema views → schemaViews.test.ts
 */

import { readFileSync } from 'fs';
import Graph from 'graphology';
import { bfsFromNode } from 'graphology-traversal';
import { beforeAll, describe, expect, it } from 'vitest';
import { extractDacpac } from '../../../src/engine/dacpacExtractor';
import { buildGraph, traceNodeWithLevels } from '../../../src/engine/graphBuilder';
import type { DatabaseModel } from '../../../src/engine/types';
import { loadAdventureWorksModel, testPath } from '../helpers/testUtils';

function directedGraph(
  nodeIds: string[],
  edges: Array<[string, string]>,
  attrs: (id: string) => Record<string, unknown> = () => ({}),
): Graph {
  const graph = new Graph({ type: 'directed', multi: false });
  for (const id of nodeIds) graph.addNode(id, attrs(id));
  for (const [source, target] of edges) {
    graph.addEdgeWithKey(`${source}→${target}`, source, target, { type: 'body' });
  }
  return graph;
}

// ─── buildGraph ───────────────────────────────────────────────────────────────

describe('buildGraph', () => {
  let model: DatabaseModel;

  beforeAll(async () => { model = await loadAdventureWorksModel(); });

  it('emits one flow node per model node', () => {
    expect(buildGraph(model).flowNodes).toHaveLength(model.nodes.length);
  });

  it('emits flow edges and a populated graphology graph', () => {
    const result = buildGraph(model);
    expect(result.flowEdges.length).toBeGreaterThan(0);
    expect(result.graph.order).toBe(model.nodes.length);
  });
});

// ─── Trace: siblings and cross-connections ────────────────────────────────────

describe('traceNodeWithLevels — siblings and shortcuts', () => {
  // GP → P1 → X → C1, GP → P2 → X → C2, plus the P1 → C1 shortcut that skips X.
  const graph = () => directedGraph(
    ['GP', 'P1', 'P2', 'X', 'C1', 'C2'],
    [['GP', 'P1'], ['GP', 'P2'], ['P1', 'X'], ['P2', 'X'], ['X', 'C1'], ['X', 'C2'], ['P1', 'C1']],
  );

  it('admits both parents and both children at depth 1', () => {
    const traced = traceNodeWithLevels(graph(), 'X', 1, 1);
    expect([...traced.nodeIds].sort()).toEqual(['C1', 'C2', 'P1', 'P2', 'X']);
  });

  it('excludes the grandparent, which sits at depth 2', () => {
    expect(traceNodeWithLevels(graph(), 'X', 1, 1).nodeIds.has('GP')).toBe(false);
  });

  it('includes every edge between traced nodes, the P1→C1 shortcut included', () => {
    const traced = traceNodeWithLevels(graph(), 'X', 1, 1);
    expect([...traced.edgeIds].sort()).toEqual(['P1→C1', 'P1→X', 'P2→X', 'X→C1', 'X→C2']);
  });

  it('reaches the whole graph when both caps are infinite', () => {
    const traced = traceNodeWithLevels(graph(), 'X', Infinity, Infinity);
    expect(traced.nodeIds.has('GP')).toBe(true);
    expect(traced.edgeIds.has('GP→P1')).toBe(true);
    expect(traced.edgeIds.has('P1→C1')).toBe(true);
  });

  it('keeps only edges flowing toward the origin when tracing upstream', () => {
    const traced = traceNodeWithLevels(graph(), 'X', 2, 0);
    expect(traced.nodeIds.has('GP')).toBe(true);
    expect([...traced.edgeIds].sort()).toEqual(['GP→P1', 'GP→P2', 'P1→X', 'P2→X']);
  });

  it('keeps only edges flowing away from the origin when tracing downstream', () => {
    const traced = traceNodeWithLevels(graph(), 'X', 0, 1);
    expect([...traced.nodeIds].sort()).toEqual(['C1', 'C2', 'X']);
    expect([...traced.edgeIds].sort()).toEqual(['X→C1', 'X→C2']);
  });
});

// ─── Trace: bidirectional edges ───────────────────────────────────────────────

describe('traceNodeWithLevels — bidirectional edges', () => {
  // SP1 both reads and writes Table and TableA, so the chain can only be walked if a
  // bidirectional pair does not terminate the traversal.
  const graph = () => directedGraph(
    ['Table', 'SP1', 'TableA', 'SP2', 'TableB', 'SP3', 'TableC'],
    [
      ['SP1', 'Table'], ['Table', 'SP1'],
      ['TableA', 'SP1'], ['SP1', 'TableA'],
      ['SP2', 'TableA'], ['TableB', 'SP2'],
      ['SP3', 'TableB'], ['TableC', 'SP3'],
    ],
    (id) => ({ type: id.startsWith('SP') ? 'procedure' : 'table' }),
  );

  it('walks past a bidirectional pair instead of stopping at it', () => {
    const traced = traceNodeWithLevels(graph(), 'Table', 7, 0);
    expect([...traced.nodeIds].sort())
      .toEqual(['SP1', 'SP2', 'SP3', 'Table', 'TableA', 'TableB', 'TableC']);
  });

  it('keeps both halves of a bidirectional pair, because each endpoint is inside the trace', () => {
    const traced = traceNodeWithLevels(graph(), 'Table', 7, 0);
    expect([...traced.edgeIds].sort())
      .toEqual([
        'SP1→Table', 'SP1→TableA', 'SP2→TableA', 'SP3→TableB',
        'TableA→SP1', 'TableB→SP2', 'TableC→SP3', 'Table→SP1',
      ]);
  });

  it('keeps every edge when both directions are active', () => {
    const traced = traceNodeWithLevels(graph(), 'Table', 7, 7);
    expect(traced.edgeIds.size).toBe(8);
    expect(traced.edgeIds.has('Table→SP1')).toBe(true);
    expect(traced.edgeIds.has('SP1→TableA')).toBe(true);
  });

  it('stops at the depth cap, counting the bidirectional hop once', () => {
    const traced = traceNodeWithLevels(graph(), 'Table', 2, 0);
    expect([...traced.nodeIds].sort()).toEqual(['SP1', 'Table', 'TableA']);
    // Every edge among the three admitted nodes, both halves of each pair included.
    expect([...traced.edgeIds].sort()).toEqual(['SP1→Table', 'SP1→TableA', 'TableA→SP1', 'Table→SP1']);
  });

  it('treats an infinite cap as the uncapped trace', () => {
    const traced = traceNodeWithLevels(graph(), 'Table', Infinity, 0);
    expect(traced.nodeIds.size).toBe(7);
    expect(traced.edgeIds.size).toBe(8);
    expect(traced.edgeIds.has('Table→SP1')).toBe(true);
  });

  it('is deterministic across repeated runs', () => {
    const signature = () => {
      const traced = traceNodeWithLevels(graph(), 'Table', 7, 0);
      return `${[...traced.nodeIds].sort()}|${[...traced.edgeIds].sort()}`;
    };
    const baseline = signature();
    expect(new Set(Array.from({ length: 50 }, signature))).toEqual(new Set([baseline]));
  });
});

// ─── Trace: virtual external nodes ────────────────────────────────────────────

describe('traceNodeWithLevels — virtual external nodes', () => {
  // FileNode → SP1 → Table1: an external file participates in the trace like any node.
  const graph = () => directedGraph(
    ['FileNode', 'SP1', 'Table1'],
    [['FileNode', 'SP1'], ['SP1', 'Table1']],
    (id) => ({ type: id === 'FileNode' ? 'external' : id.startsWith('SP') ? 'procedure' : 'table' }),
  );

  it('reaches the external node upstream and the table downstream', () => {
    const traced = traceNodeWithLevels(graph(), 'SP1', Infinity, Infinity);
    expect([...traced.nodeIds].sort()).toEqual(['FileNode', 'SP1', 'Table1']);
    expect([...traced.edgeIds].sort()).toEqual(['FileNode→SP1', 'SP1→Table1']);
  });

  it('stops short of the external node at depth 1', () => {
    const traced = traceNodeWithLevels(graph(), 'Table1', 1, 0);
    expect(traced.nodeIds.has('SP1')).toBe(true);
    expect(traced.nodeIds.has('FileNode')).toBe(false);
  });

  it('reaches the external node at depth 2, with its edge', () => {
    const traced = traceNodeWithLevels(graph(), 'Table1', 2, 0);
    expect(traced.nodeIds.has('FileNode')).toBe(true);
    expect(traced.edgeIds.has('FileNode→SP1')).toBe(true);
  });
});

// ─── Trace: real Synapse model ────────────────────────────────────────────────

describe('traceNodeWithLevels — Synapse dacpac', () => {
  it('never returns an edge whose endpoint is outside the traced node set', async () => {
    const model = await extractDacpac(readFileSync(testPath('AdventureWorks_sdk-style.dacpac')));
    const { graph } = buildGraph(model);

    // Collected across every eligible procedure, then asserted once, so a failure names
    // every offending procedure rather than aborting at the first.
    const phantoms: string[] = [];
    let checked = 0;

    for (const proc of model.nodes.filter(node => node.type === 'procedure')) {
      if (!graph.hasNode(proc.id)) continue;
      if (graph.inDegree(proc.id) < 2 || graph.outDegree(proc.id) < 1) continue;
      checked++;

      const traced = traceNodeWithLevels(graph, proc.id, 2, 2);
      for (const edgeId of traced.edgeIds) {
        const source = graph.source(edgeId);
        const target = graph.target(edgeId);
        if (!traced.nodeIds.has(source) || !traced.nodeIds.has(target)) {
          phantoms.push(`${proc.id}: ${edgeId}`);
        }
      }
    }

    expect(checked).toBeGreaterThan(0);
    expect(phantoms).toEqual([]);
  });

  it('reaches the same node set as a raw graphology BFS at the same depth', async () => {
    const model = await extractDacpac(readFileSync(testPath('AdventureWorks_sdk-style.dacpac')));
    const { graph } = buildGraph(model);
    const origin = model.nodes.find(node => node.type === 'procedure' && graph.hasNode(node.id)
      && graph.inDegree(node.id) >= 2 && graph.outDegree(node.id) >= 1);
    expect(origin).toBeDefined();

    const reference = new Set<string>([origin!.id]);
    for (const mode of ['inbound', 'outbound'] as const) {
      bfsFromNode(graph, origin!.id, (node: string, _attrs: unknown, depth: number) => {
        if (depth > 2) return true;
        reference.add(node);
      }, { mode });
    }

    expect(traceNodeWithLevels(graph, origin!.id, 2, 2).nodeIds).toEqual(reference);
  });
});
