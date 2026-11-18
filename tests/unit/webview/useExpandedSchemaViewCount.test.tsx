// @vitest-environment jsdom
/**
 * Expanded Schema View projects the rendered-node count once per input change and reuses it for
 * the render-limit check, instead of projecting the same schemas a second time for the graph.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildGraphologyGraph } from '../../../src/engine/graphBuilder';
import { DEFAULT_CONFIG, type DatabaseModel } from '../../../src/engine/types';
import { useExpandedSchemaView } from '../../../src/hooks/useExpandedSchemaView';

const counted = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../../../src/engine/schemaProjection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/engine/schemaProjection')>();
  return {
    ...actual,
    countExpandedSchemaViewRenderedNodes: (...args: Parameters<typeof actual.countExpandedSchemaViewRenderedNodes>) => {
      counted.calls++;
      return actual.countExpandedSchemaViewRenderedNodes(...args);
    },
  };
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const model: DatabaseModel = {
  nodes: [
    { id: '[dbo].[a]', name: 'a', schema: 'dbo', fullName: '[dbo].[a]', type: 'table' },
    { id: '[dbo].[b]', name: 'b', schema: 'dbo', fullName: '[dbo].[b]', type: 'view' },
    { id: '[s2].[c]', name: 'c', schema: 's2', fullName: '[s2].[c]', type: 'view' },
  ],
  edges: [{ source: '[dbo].[a]', target: '[dbo].[b]', type: 'body' }, { source: '[dbo].[b]', target: '[s2].[c]', type: 'body' }],
  schemas: [], catalog: {}, neighborIndex: {},
} as unknown as DatabaseModel;
const graph = buildGraphologyGraph(model);
const expandedSchemaView = { focusNodeId: null, expandedSchemas: new Set(['dbo']) };

let root: Root;
let host: HTMLDivElement;
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('useExpandedSchemaView rendered count', () => {
  it('counts the projected nodes once and builds the graph from that count', () => {
    let result: ReturnType<typeof useExpandedSchemaView> | undefined;
    function Harness() {
      result = useExpandedSchemaView({
        config: DEFAULT_CONFIG,
        expandedSchemaView,
        filterSchemas: new Set(['dbo', 's2']),
        graph,
        graphMode: 'overview',
        model,
        preserveViewportOnNextGraphChange: () => {},
        setExpandedSchemaView: () => {},
        setShowExpandedSchemaClusters: () => {},
        showExpandedSchemaClusters: true,
      });
      return null;
    }
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(<Harness />));
    expect(result!.expandedSchemaViewGraph).not.toBeNull();
    expect(result!.expandedSchemaViewRenderedCount).toBe(3);
    expect(counted.calls).toBe(1);
  });
});
