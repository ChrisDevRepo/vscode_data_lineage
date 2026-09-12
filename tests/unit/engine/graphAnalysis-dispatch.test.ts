/**
 * Covers `runAnalysis` — the dispatcher the product calls.
 *
 * The per-analysis functions are tested directly in graphAnalysis.test.ts, but nothing
 * exercised the switch that routes to them or the threshold arithmetic it applies. A
 * mis-wired case there returns a well-formed report for the wrong analysis, which every
 * direct-call test still passes.
 */

import Graph from 'graphology';
import { describe, expect, it } from 'vitest';
import { runAnalysis } from '../../../src/engine/graphAnalysis';
import type { AnalysisConfig, AnalysisType } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';

const CONFIG: AnalysisConfig = { hubMinDegree: 2, islandMaxSize: 4, longestPathMinNodes: 2 };

/**
 * One hub (`H`, degree 4), one 2-node island (`I1`→`I2`), one orphan (`O`), one cycle
 * (`C1`→`C2`→`C1`) and a chain long enough for the longest-path analysis.
 */
function mixedGraph(): Graph {
  return makeGraph(
    [
      { id: 'H' }, { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' },
      { id: 'I1' }, { id: 'I2' },
      { id: 'O' },
      { id: 'C1' }, { id: 'C2' },
    ],
    [
      ['a', 'H'], ['b', 'H'], ['H', 'c'], ['H', 'd'],
      ['I1', 'I2'],
      ['C1', 'C2'], ['C2', 'C1'],
    ],
  );
}

describe('runAnalysis — dispatch', () => {
  const TYPES: AnalysisType[] = ['islands', 'hubs', 'orphans', 'longest-path', 'cycles', 'external-refs'];

  it.each(TYPES)('routes %s to the matching analysis and labels the result with it', (type) => {
    const result = runAnalysis(mixedGraph(), type, CONFIG);
    expect(result.type).toBe(type);
    expect(typeof result.summary).toBe('string');
    expect(Array.isArray(result.groups)).toBe(true);
  });

  it.each(TYPES)('returns an empty %s report for an empty graph instead of throwing', (type) => {
    const result = runAnalysis(new Graph({ type: 'directed', multi: false }), type, CONFIG);
    expect(result.type).toBe(type);
    expect(result.groups).toEqual([]);
  });

  it('finds the island, the hub, the orphan and the cycle each under its own type', () => {
    const graph = mixedGraph();
    const nodesOf = (type: AnalysisType): string[] =>
      runAnalysis(graph, type, CONFIG).groups.flatMap(group => group.nodeIds).sort();
    // The hub component (5 nodes) exceeds islandMaxSize; the two 2-node components remain.
    expect(nodesOf('islands')).toEqual(['C1', 'C2', 'I1', 'I2']);
    expect(runAnalysis(graph, 'hubs', CONFIG).groups.map(group => group.id)).toContain('hub-H');
    expect(nodesOf('orphans')).toEqual(['O']);
    expect(nodesOf('cycles')).toEqual(['C1', 'C2']);
  });

  it('caps islandMaxSize at maxNodes — the tighter of the two bounds wins', () => {
    const graph = makeGraph(
      [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
      [['A', 'B'], ['B', 'C']],
    );
    // islandMaxSize alone would admit the 3-node component; maxNodes=2 must veto it.
    expect(runAnalysis(graph, 'islands', { ...CONFIG, islandMaxSize: 3 }, 2).groups).toEqual([]);
    expect(runAnalysis(graph, 'islands', { ...CONFIG, islandMaxSize: 3 }, 3).groups).toHaveLength(1);
  });

  it('caps how many chains longest-path reports, without displacing the deepest one', () => {
    // 40 independent 6-node chains, plus one 9-node chain that must survive the cap at rank 0.
    const nodes: Array<{ id: string }> = [];
    const edges: Array<[string, string]> = [];
    for (let chain = 0; chain < 40; chain++) {
      for (let step = 0; step < 6; step++) {
        nodes.push({ id: `n${chain}_${step}` });
        if (step > 0) edges.push([`n${chain}_${step - 1}`, `n${chain}_${step}`]);
      }
    }
    for (let step = 0; step < 9; step++) {
      nodes.push({ id: `deep_${step}` });
      if (step > 0) edges.push([`deep_${step - 1}`, `deep_${step}`]);
    }

    const groups = runAnalysis(makeGraph(nodes, edges), 'longest-path', CONFIG).groups;
    expect(groups.length).toBeLessThan(40);
    expect(groups[0].nodeIds).toHaveLength(9);
  });

  it('threads hubMinDegree through rather than applying a built-in default', () => {
    const graph = mixedGraph();
    expect(runAnalysis(graph, 'hubs', { ...CONFIG, hubMinDegree: 4 }).groups.map(group => group.id)).toContain('hub-H');
    expect(runAnalysis(graph, 'hubs', { ...CONFIG, hubMinDegree: 99 }).groups).toEqual([]);
  });
});
