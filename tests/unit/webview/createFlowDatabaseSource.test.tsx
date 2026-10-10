// @vitest-environment jsdom
//
// The wizard honors selected-provider availability and offers the existing built-in switch.
import { StrictMode, act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    fileName: null, filePath: null, status: null, mssqlAvailable: true, connectionProvider: 'builtIn', switchToBuiltInConnection: () => {}, pendingAutoVisualize: false, pendingVisualize: false, isDemo: false,
    openFile: () => {}, resetToStart: () => {}, loadProject: () => {}, loadDemo: () => {}, connectToDatabase: () => {},
    cancelLoading: () => {}, clearAutoVisualize: () => {}, clearPendingVisualize: () => {}, visualize: () => {},
    toggleSchema: () => {}, selectAllSchemas: () => {}, clearAllSchemas: () => {},
    ...overrides,
  };
}

const connectButton = () => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Connect to database'));

describe('CreateFlow database source', () => {
  it('offers the connect button without a provider notice or switch', () => {
    const connectToDatabase = vi.fn();
    mount(<CreateFlow loader={makeLoader({ connectToDatabase })} maxNodes={2000} onBack={() => {}} onVisualize={() => {}} />);

    expect(connectButton()?.disabled).toBe(false);
    expect([...host.querySelectorAll('button')].some((b) => b.textContent?.includes('Use Built-in Connection'))).toBe(false);
    act(() => connectButton()!.click());
    expect(connectToDatabase).toHaveBeenCalledTimes(1);
  });

  it('disables an unavailable mssql provider and lets the user select built-in', () => {
    const switchToBuiltInConnection = vi.fn();
    mount(<CreateFlow loader={makeLoader({ mssqlAvailable: false, connectionProvider: 'mssqlExtension', switchToBuiltInConnection })} maxNodes={2000} onBack={() => {}} onVisualize={() => {}} />);
    expect(connectButton()?.disabled).toBe(true);
    const switchButton = [...host.querySelectorAll('button')].find(b => b.textContent?.includes('Use Built-in Connection'));
    expect(switchButton).toBeDefined();
    act(() => switchButton!.click());
    expect(switchToBuiltInConnection).toHaveBeenCalledTimes(1);
  });

  it('disables the connect button while a load runs', () => {
    mount(<CreateFlow loader={makeLoader({ isLoading: true })} maxNodes={2000} onBack={() => {}} onVisualize={() => {}} />);
    expect(connectButton()?.disabled).toBe(true);
  });
});

describe('bridge provider compatibility', () => {
  it('accepts provider status and switch messages', () => {
    expect(ExtensionToWebviewMsgSchema.safeParse({ type: 'mssql-status', available: true, provider: 'builtIn' }).success).toBe(true);
    expect(MainPanelToExtensionMsgSchema.safeParse({ type: 'use-builtin-connection' }).success).toBe(true);
    expect(MainPanelToExtensionMsgSchema.safeParse({ type: 'check-mssql' }).success).toBe(true);
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
