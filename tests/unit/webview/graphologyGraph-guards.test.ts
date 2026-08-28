// @vitest-environment jsdom
/**
 * Covers the four defensive guards in `buildGraphologyGraph` (src/engine/graphBuilder.ts):
 * an empty-id node is skipped and warned, a duplicate node id is skipped and warned, an edge
 * whose source or target is not a graph node is dropped without a warning, and a duplicate
 * source→target edge is added only once. None of the four had a test before this file — the
 * warn branches post through `window.vscode`, which the `environment: 'node'` engine lane
 * (where these guards otherwise live, tests/unit/engine/graphBuilder.test.ts) cannot exercise
 * because `window` is undefined there. Lives under webview/ for the same reason
 * applyTraceToFlow.test.ts does.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { buildGraphologyGraph } from '../../../src/engine/graphBuilder';
import type { DatabaseModel, LineageEdge, LineageNode } from '../../../src/engine/types';

function node(overrides: Partial<LineageNode> = {}): LineageNode {
  return {
    id: '[dbo].[table1]',
    schema: 'dbo',
    name: 'Table1',
    fullName: '[dbo].[Table1]',
    type: 'table',
    ...overrides,
  };
}

function modelOf(nodes: LineageNode[], edges: LineageEdge[]): DatabaseModel {
  return { nodes, edges, schemas: [], catalog: {}, neighborIndex: {} } as unknown as DatabaseModel;
}

type PostedMessage = Record<string, unknown>;

describe('buildGraphologyGraph — defensive guards', () => {
  let posted: PostedMessage[];

  beforeEach(() => {
    posted = [];
    window.vscode = {
      postMessage: (message) => { posted.push(message); },
      getState: () => undefined,
      setState: () => {},
    };
  });

  it('skips a node with an empty id and warns with its schema.name', () => {
    const model = modelOf([node({ id: '', schema: 'dbo', name: 'Ghost' })], []);

    const graph = buildGraphologyGraph(model);

    expect(graph.order).toBe(0);
    expect(posted).toEqual([
      { type: 'log', level: 'warn', text: '[Graph] Skipping node with empty ID: dbo.Ghost' },
    ]);
  });

  it('skips a duplicate node id and warns with the id', () => {
    const model = modelOf(
      [
        node({ id: '[dbo].[table1]', name: 'Table1' }),
        node({ id: '[dbo].[table1]', name: 'Table1Again' }),
      ],
      [],
    );

    const graph = buildGraphologyGraph(model);

    expect(graph.order).toBe(1);
    expect(graph.getNodeAttribute('[dbo].[table1]', 'name')).toBe('Table1');
    expect(posted).toEqual([
      { type: 'log', level: 'warn', text: '[Graph] Duplicate node ID skipped: [dbo].[table1]' },
    ]);
  });

  it('drops an edge whose source is not a node in the graph, without warning', () => {
    const model = modelOf(
      [node({ id: '[dbo].[table1]' })],
      [{ source: '[dbo].[missing]', target: '[dbo].[table1]', type: 'body' }],
    );

    const graph = buildGraphologyGraph(model);

    expect(graph.size).toBe(0);
    expect(posted).toEqual([]);
  });

  it('drops an edge whose target is not a node in the graph, without warning', () => {
    const model = modelOf(
      [node({ id: '[dbo].[table1]' })],
      [{ source: '[dbo].[table1]', target: '[dbo].[missing]', type: 'body' }],
    );

    const graph = buildGraphologyGraph(model);

    expect(graph.size).toBe(0);
    expect(posted).toEqual([]);
  });

  it('adds a duplicate source→target edge only once, keeping the first edge attrs', () => {
    const model = modelOf(
      [
        node({ id: '[dbo].[table1]' }),
        node({ id: '[dbo].[table2]', name: 'Table2', fullName: '[dbo].[Table2]' }),
      ],
      [
        { source: '[dbo].[table1]', target: '[dbo].[table2]', type: 'body' },
        { source: '[dbo].[table1]', target: '[dbo].[table2]', type: 'exec' },
      ],
    );

    const graph = buildGraphologyGraph(model);

    expect(graph.size).toBe(1);
    expect(graph.getEdgeAttribute('[dbo].[table1]→[dbo].[table2]', 'type')).toBe('body');
    expect(posted).toEqual([]);
  });
});
