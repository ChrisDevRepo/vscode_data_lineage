// @vitest-environment jsdom
//
// A selection over `dataLineageViz.maxNodes` must stop the wizard cold: Visualize disabled, an
// error-styled status banner naming the count and the limit, and no "trimmed" wording anywhere —
// the wizard never lets a user proceed into a silently-cut model.
import { StrictMode, act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CreateFlow } from '../../../src/components/CreateFlow';
import { formatObjectLimitMessage } from '../../../src/engine/modelFilters';
import type { DacpacLoaderState } from '../../../src/hooks/useDacpacLoader';
import type { SchemaInfo, SchemaPreview } from '../../../src/engine/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const MAX_NODES = 2000;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function mount(element: ReactElement): void {
  act(() => root.render(<StrictMode>{element}</StrictMode>));
}

function schema(name: string, nodeCount: number): SchemaInfo {
  return { name, nodeCount, types: { table: nodeCount, view: 0, procedure: 0, function: 0, external: 0 } };
}

/** A minimal loader with a two-schema Phase 1 preview, both schemas selected. */
function makeLoader(schemas: SchemaInfo[]): DacpacLoaderState {
  const preview: SchemaPreview = {
    schemas,
    totalObjects: schemas.reduce((sum, s) => sum + s.nodeCount, 0),
  };
  return {
    model: null,
    schemaPreview: preview,
    selectedSchemas: new Set(schemas.map(s => s.name)),
    isLoading: false,
    loadingContext: null,
    fileName: 'synthetic.dacpac',
    filePath: '/tmp/synthetic.dacpac',
    status: null,
    mssqlAvailable: null,
    pendingAutoVisualize: false,
    pendingVisualize: false,
    isDemo: false,
    openFile: () => {},
    resetToStart: () => {},
    loadProject: () => {},
    loadDemo: () => {},
    connectToDatabase: () => {},
    cancelLoading: () => {},
    clearAutoVisualize: () => {},
    clearPendingVisualize: () => {},
    visualize: () => {},
    toggleSchema: () => {},
    selectAllSchemas: () => {},
    clearAllSchemas: () => {},
  };
}

function visualizeButton(): HTMLButtonElement {
  const button = [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Visualize');
  if (!button) throw new Error('Visualize button not found');
  return button as HTMLButtonElement;
}

describe('CreateFlow refuses an over-limit schema selection', () => {
  it('disables Visualize and shows the error-styled limit message when the selection exceeds maxNodes', () => {
    const selectedCount = 2500;
    const loader = makeLoader([schema('dbo', 1500), schema('sales', 1000)]);

    mount(<CreateFlow loader={loader} maxNodes={MAX_NODES} onBack={() => {}} onVisualize={() => {}} />);

    expect(visualizeButton().disabled, 'Visualize must be disabled over the limit').toBe(true);

    const banner = host.querySelector('.ln-status-error');
    expect(banner, 'an error-styled status banner is rendered').not.toBeNull();

    const expectedText = formatObjectLimitMessage(selectedCount, MAX_NODES);
    const bodyText = banner!.querySelector('.ln-status-body')?.textContent ?? '';
    expect(bodyText, 'the full shared message, including the setting name, is rendered untruncated').toBe(expectedText);

    expect(host.textContent, 'the retired "trimmed" wording never appears').not.toContain('trimmed');
    expect(host.textContent).not.toContain('Largest schemas');
  });

  it('leaves Visualize enabled and shows the plain count when the selection is within maxNodes', () => {
    const loader = makeLoader([schema('dbo', 500), schema('sales', 400)]);

    mount(<CreateFlow loader={loader} maxNodes={MAX_NODES} onBack={() => {}} onVisualize={() => {}} />);

    expect(visualizeButton().disabled).toBe(false);
    expect(host.querySelector('.ln-status-error')).toBeNull();
    expect(host.textContent).toContain('900 objects selected');
  });

  it('calling Visualize while over the limit is impossible — the button stays disabled through a click', () => {
    let visualizeCalls = 0;
    const loader = makeLoader([schema('dbo', 2001)]);

    mount(<CreateFlow loader={loader} maxNodes={MAX_NODES} onBack={() => {}} onVisualize={() => { visualizeCalls++; }} />);

    const button = visualizeButton();
    expect(button.disabled).toBe(true);
    act(() => button.click());
    expect(visualizeCalls, 'a disabled button never fires onVisualize').toBe(0);
  });
});
