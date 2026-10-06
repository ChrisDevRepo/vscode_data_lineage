// @vitest-environment jsdom
/**
 * Pins the schema-filter admission guard: a schema toggle whose selection would exceed
 * `dataLineageViz.maxNodes` is refused with the limit warning and leaves the filter as it was; a
 * toggle within the limit is applied.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateDwhModel } from '../helpers/dwhGraphGenerator';
import { BRIDGE_PROTOCOL_VERSION } from '../../../src/engine/shared/bridgeContract';
import { DEFAULT_CONFIG, type FilterState } from '../../../src/engine/types';
import { VsCodeProvider } from '../../../src/contexts/VsCodeContext';

type CanvasProps = {
  filter: FilterState;
  onToggleSchema?: (schema: string) => void;
  onSelectNoneSchemas?: (schemas: string[]) => void;
};
const canvas = vi.hoisted(() => ({ props: null as CanvasProps | null }));
vi.mock('../../../src/components/GraphCanvas', () => ({
  GraphCanvas: (props: CanvasProps) => { canvas.props = props; return null; },
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

type Posted = { type: string; text?: string };

let host: HTMLDivElement;
let root: Root;
let posted: Posted[];
const w = window as unknown as { vscode?: { postMessage: (m: unknown) => void } };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  posted = [];
  canvas.props = null;
  w.vscode = { postMessage: (m: unknown) => { posted.push(m as Posted); } };
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete w.vscode;
  vi.useRealTimers();
});

const objectViewConfig = { ...DEFAULT_CONFIG, overview: { ...DEFAULT_CONFIG.overview, enabled: false } };

function post(data: object): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { protocolVersion: BRIDGE_PROTOCOL_VERSION, ...data } }));
  });
}

const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(1300); });

describe('schema selection admission', () => {
  it('refuses a schema toggle over maxNodes with the limit warning and keeps the filter', async () => {
    const { App } = await import('../../../src/components/App');
    act(() => {
      root.render(
        <VsCodeProvider api={{ postMessage: (m: unknown) => { posted.push(m as Posted); } } as never}>
          <App />
        </VsCodeProvider>
      );
    });
    const { model } = generateDwhModel({ objectCount: 40, seed: 1, profile: { externalRefCount: 0, schemaCount: 3 } });
    post({ type: 'dacpac-model', model, config: objectViewConfig, sourceName: 'big.dacpac', autoVisualize: true });
    await settle();

    const [first, second] = model.schemas.map(s => s.name);
    const firstCount = model.nodes.filter(n => n.schema === first).length;
    act(() => canvas.props!.onSelectNoneSchemas!(model.schemas.map(s => s.name)));
    act(() => canvas.props!.onToggleSchema!(first));
    expect([...canvas.props!.filter.schemas]).toEqual([first]);

    post({ type: 'rebuild-config', config: { ...objectViewConfig, maxNodes: firstCount } });
    await settle();
    posted.length = 0;

    act(() => canvas.props!.onToggleSchema!(second));
    expect([...canvas.props!.filter.schemas], 'the refused selection is not committed').toEqual([first]);
    expect(posted.filter(m => m.type === 'show-warning' && new RegExp(`limit ${firstCount}\\b`).test(m.text ?? ''))).toHaveLength(1);
    expect(posted.filter(m => m.type === 'error')).toEqual([]);
  }, 15000);
});
