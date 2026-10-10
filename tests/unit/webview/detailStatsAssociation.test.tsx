// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LineageNode } from '../../../src/engine/types';
import type { TableStatsState } from '../../../src/components/TableDetailPanel';
import { BRIDGE_PROTOCOL_VERSION } from '../../../src/engine/shared/bridgeContract';

const panel = vi.hoisted(() => ({ props: null as { objectName: string; statsState: TableStatsState; onRequestStats: (mode: 'quick') => void } | null }));
const api = vi.hoisted(() => ({ postMessage: vi.fn() }));
vi.mock('../../../src/components/TableDetailPanel', () => ({ TableDetailPanel: (props: NonNullable<typeof panel.props>) => { panel.props = props; return null; } }));
vi.mock('../../../src/detail/MonacoSqlView', () => ({ MonacoSqlView: () => null }));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  vi.stubGlobal('acquireVsCodeApi', () => api);
  api.postMessage.mockClear();
  panel.props = null;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const { DetailApp } = await import('../../../src/detail/DetailApp');
  act(() => root.render(<DetailApp />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function frame(data: object): void {
  window.dispatchEvent(new MessageEvent('message', { data: { protocolVersion: BRIDGE_PROTOCOL_VERSION, ...data } }));
}
function show(node: LineageNode): void {
  frame({ type: 'detail-update', node, config: { isDbMode: true, statsEnabled: true, excludeExternalTables: false, standardModeEnabled: true } });
}
const table = (schema: string, name: string): LineageNode => ({ id: `[${schema}].[${name}]`, schema, name, fullName: `${schema}.${name}`, type: 'table', columns: [] });
const original = table('dbo', 'Orders');
const result = { type: 'table-stats-result', stats: { rowCount: 0, columns: [], sampled: false }, mode: 'quick' };
const error = { type: 'table-stats-error', message: 'Synthetic profiling failure' };

describe('detail statistics association', () => {
  it.each([
    { label: 'another schema result', node: table('sales', 'Orders'), reply: result },
    { label: 'another object result', node: table('dbo', 'Customers'), reply: result },
    { label: 'another schema error', node: table('sales', 'Orders'), reply: error },
    { label: 'another object error', node: table('dbo', 'Customers'), reply: error },
  ])('ignores delayed replies for $label', ({ node, reply }) => {
    act(() => show(original));
    act(() => panel.props!.onRequestStats('quick'));
    act(() => show(node));
    act(() => frame({ ...reply, schema: original.schema, objectName: original.name }));
    expect(panel.props!.statsState).toEqual({ phase: 'idle' });
  });

  it.each([result, error])('associates queued replies with the latest detail-update before React commits: $type', reply => {
    act(() => show(original));
    act(() => {
      show(table('dbo', 'Customers'));
      frame({ ...reply, schema: original.schema, objectName: original.name });
    });
    expect(panel.props!.statsState).toEqual({ phase: 'idle' });
  });

  it.each([result, error])('accepts a normal current-table reply, including measured zero rows: $type', reply => {
    act(() => show(original));
    act(() => panel.props!.onRequestStats('quick'));
    act(() => frame({ ...reply, schema: original.schema, objectName: original.name }));
    expect(panel.props!.statsState).toEqual(reply.type === 'table-stats-result'
      ? { phase: 'result', stats: result.stats, mode: 'quick' }
      : { phase: 'error', message: error.message });
  });

  it('rejects an uncorrelated statistics frame', () => {
    act(() => show(original));
    act(() => frame(result));
    expect(panel.props!.statsState).toEqual({ phase: 'idle' });
  });
});
