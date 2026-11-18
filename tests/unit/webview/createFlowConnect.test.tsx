// @vitest-environment jsdom
//
// The wizard offers the database connection without any provider notice, the retired provider messages
// leave the bridge contract, and each visible Project name label belongs to its own field.
import { StrictMode, act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CreateFlow } from '../../../src/components/CreateFlow';
import type { DacpacLoaderState } from '../../../src/hooks/useDacpacLoader';
import { ExtensionToWebviewMsgSchema, MainPanelToExtensionMsgSchema } from '../../../src/engine/shared/bridgeContract';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

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

function makeLoader(overrides: Partial<DacpacLoaderState>): DacpacLoaderState {
  return {
    model: null, schemaPreview: null, selectedSchemas: new Set(), isLoading: false, loadingContext: null,
    fileName: null, filePath: null, status: null, pendingAutoVisualize: false, pendingVisualize: false, isDemo: false,
    openFile: () => {}, resetToStart: () => {}, loadProject: () => {}, loadDemo: () => {}, connectToDatabase: () => {},
    cancelLoading: () => {}, clearAutoVisualize: () => {}, clearPendingVisualize: () => {}, visualize: () => {},
    toggleSchema: () => {}, selectAllSchemas: () => {}, clearAllSchemas: () => {},
    ...overrides,
  };
}

describe('CreateFlow connect button', () => {
  it('is always offered and enabled: connections no longer depend on another extension', () => {
    mount(<CreateFlow loader={makeLoader({})} maxNodes={2000} onBack={() => {}} onVisualize={() => {}} />);
    const connect = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Connect to database'));
    expect(connect).toBeDefined();
    expect(connect!.disabled).toBe(false);
    expect(host.querySelector('[role="status"]')).toBeNull();
  });
});

describe('bridge contract without the mssql extension provider', () => {
  it('rejects the retired provider-status and provider-switch messages', () => {
    expect(ExtensionToWebviewMsgSchema.safeParse({ type: 'mssql-status', available: true, provider: 'builtIn' }).success).toBe(false);
    expect(MainPanelToExtensionMsgSchema.safeParse({ type: 'check-mssql' }).success).toBe(false);
    expect(MainPanelToExtensionMsgSchema.safeParse({ type: 'use-builtin-connection' }).success).toBe(false);
  });
});

describe('CreateFlow project-name accessibility', () => {
  it('associates each visible Project name label with its own editable field', () => {
    const loader = makeLoader({ schemaPreview: { schemas: [], totalObjects: 0 }, fileName: 'AdventureWorks2022' });
    mount(<><CreateFlow loader={loader} maxNodes={2000} onBack={() => {}} onVisualize={() => {}} /><CreateFlow loader={loader} maxNodes={2000} onBack={() => {}} onVisualize={() => {}} /></>);
    const labels = [...host.querySelectorAll('label')].filter(label => label.textContent === 'Project name');
    expect(labels).toHaveLength(2);
    const controls = labels.map(label => label.control);
    for (const control of controls) {
      expect(control).toBeInstanceOf(HTMLInputElement);
      expect((control as HTMLInputElement).type).toBe('text');
      expect((control as HTMLInputElement).disabled).toBe(false);
    }
    expect(controls[0]).not.toBe(controls[1]);
  });
});
