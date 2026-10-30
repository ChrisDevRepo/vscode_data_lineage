/** Owns graph construction, layout failures and annotation spacing. Synthetic trace membership/depth contracts live in traversal-edge-cases.test.ts; the SDK-style DACPAC test here retains extraction-to-trace integrity coverage. */

import { readFileSync } from 'fs';
import dagre from '@dagrejs/dagre';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { extractDacpac } from '../../../src/engine/dacpacExtractor';
import {
  AI_BADGE_BAND,
  AI_NOTE_BAND,
  NODE_HEIGHT,
  buildGraph,
  dagreLayout,
  setGraphLogSink,
  traceNodeWithLevels,
} from '../../../src/engine/graphBuilder';
import { DEFAULT_CONFIG, type DatabaseModel } from '../../../src/engine/types';
import { loadAdventureWorksModel, testPath } from '../helpers/testUtils';

describe('buildGraph', () => {
  let model: DatabaseModel;

  beforeAll(async () => {
    model = await loadAdventureWorksModel();
  });

  it('emits one flow node per model node', () => {
    expect(buildGraph(model).flowNodes).toHaveLength(model.nodes.length);
  });

  it('emits flow edges and a populated graphology graph', () => {
    const result = buildGraph(model);
    expect(result.flowEdges.length).toBeGreaterThan(0);
    expect(result.graph.order).toBe(model.nodes.length);
  });
});

describe('traceNodeWithLevels — SDK-style AdventureWorks dacpac', () => {
  it('never returns an edge whose endpoint is outside the traced node set', async () => {
    const model = await extractDacpac(
      readFileSync(testPath('AdventureWorks_sdk-style.dacpac')),
    );
    const { graph } = buildGraph(model);

    const phantoms: string[] = [];
    let checked = 0;

    for (const proc of model.nodes.filter(
      (node) => node.type === 'procedure',
    )) {
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
});

describe('dagreLayout — layout failure', () => {
  function layoutThrowing(
    nodeIds: string[],
  ): Map<string, { x: number; y: number }> {
    const spy = vi.spyOn(dagre, 'layout').mockImplementation(() => {
      throw new Error('rank assignment failed');
    });
    try {
      return dagreLayout({
        nodeIds,
        edges: [{ source: nodeIds[0], target: nodeIds[1] }],
        config: DEFAULT_CONFIG,
      });
    } finally {
      spy.mockRestore();
    }
  }

  it('returns an empty map and warns the installed sink, naming the error', () => {
    const lines: Array<{ level: string; text: string }> = [];
    setGraphLogSink((level, text) => lines.push({ level, text }));
    try {
      expect(layoutThrowing(['sink.a', 'sink.b']).size).toBe(0);
    } finally {
      setGraphLogSink(() => {});
    }

    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('warn');
    expect(lines[0].text).toContain('[Graph] Dagre layout failed');
    expect(lines[0].text).toContain('rank assignment failed');
  });

  it('swallows the failure when no sink is installed', () => {
    expect(() => layoutThrowing(['default.a', 'default.b'])).not.toThrow();
  });
});

describe('dagreLayout — AI badge/footnote band', () => {
  /** Two same-rank siblings under one root, so `nodesep` alone governs their vertical gap. */
  function siblingLayout(
    annotatedNodeIds?: string[],
  ): Map<string, { x: number; y: number }> {
    return dagreLayout({
      nodeIds: ['root', 'a', 'b'],
      edges: [
        { source: 'root', target: 'a' },
        { source: 'root', target: 'b' },
      ],
      config: DEFAULT_CONFIG,
      direction: 'LR',
      ...(annotatedNodeIds && { annotatedNodeIds }),
    });
  }

  /** Vertical space between the two nodes' real boxes, independent of which one dagre stacked on top. */
  function realGap(positions: Map<string, { x: number; y: number }>): number {
    const a = positions.get('a')!;
    const b = positions.get('b')!;
    const [top, bottom] = a.y <= b.y ? [a, b] : [b, a];
    return bottom.y - (top.y + NODE_HEIGHT);
  }

  const band = AI_BADGE_BAND + AI_NOTE_BAND;

  it('leaves only the configured node separation between stacked nodes with no annotation', () => {
    expect(realGap(siblingLayout())).toBeLessThan(band);
  });

  it('reserves the badge-plus-footnote band between stacked annotated nodes', () => {
    expect(realGap(siblingLayout(['a', 'b']))).toBeGreaterThanOrEqual(band);
  });
});
