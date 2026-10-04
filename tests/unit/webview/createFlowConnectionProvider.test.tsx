// @vitest-environment jsdom
//
// The wizard warns inline that the mssql connection API is retiring while that provider is selected,
// offers a one-click switch to the built-in connection, and shows nothing for the built-in provider.
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
    fileName: null, filePath: null, status: null, mssqlAvailable: true, connectionProvider: null,
    switchToBuiltInConnection: () => {}, pendingAutoVisualize: false, pendingVisualize: false, isDemo: false,
    openFile: () => {}, resetToStart: () => {}, loadProject: () => {}, loadDemo: () => {}, connectToDatabase: () => {},
    cancelLoading: () => {}, clearAutoVisualize: () => {}, clearPendingVisualize: () => {}, visualize: () => {},
    toggleSchema: () => {}, selectAllSchemas: () => {}, clearAllSchemas: () => {},
    ...overrides,
  };
}

const notice = () => host.querySelector('[role="status"].ln-provider-notice');
const switchButton = () => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Use Built-in Connection');

describe('CreateFlow connection provider notice', () => {
  it('shows the retirement warning and the switch button for the mssql extension provider', () => {
    mount(<CreateFlow loader={makeLoader({ connectionProvider: 'mssqlExtension' })} maxNodes={2000} onBack={() => {}} onVisualize={() => {}} />);

    expect(notice()?.textContent).toContain(
      "This connection uses the SQL Server (mssql) extension's connection API, which Microsoft is retiring. Use the built-in connection instead.",
    );
    expect(switchButton()).toBeDefined();
  });

  it('shows nothing for the built-in provider or before the status arrives', () => {
    mount(<CreateFlow loader={makeLoader({ connectionProvider: 'builtIn' })} maxNodes={2000} onBack={() => {}} onVisualize={() => {}} />);
    expect(notice()).toBeNull();
    expect(switchButton()).toBeUndefined();

    mount(<CreateFlow loader={makeLoader({ connectionProvider: null })} maxNodes={2000} onBack={() => {}} onVisualize={() => {}} />);
    expect(notice()).toBeNull();
  });

  it('the button asks the loader to switch, once per click and without a click event argument', () => {
    const switchToBuiltInConnection = vi.fn();
    mount(<CreateFlow loader={makeLoader({ connectionProvider: 'mssqlExtension', switchToBuiltInConnection })} maxNodes={2000} onBack={() => {}} onVisualize={() => {}} />);

    act(() => switchButton()!.click());

    expect(switchToBuiltInConnection).toHaveBeenCalledTimes(1);
    expect(switchToBuiltInConnection.mock.calls[0]).toEqual([]);
  });

  it('is not a modal and does not replace the connect button', () => {
    mount(<CreateFlow loader={makeLoader({ connectionProvider: 'mssqlExtension' })} maxNodes={2000} onBack={() => {}} onVisualize={() => {}} />);
    expect(host.querySelector('[aria-modal="true"]')).toBeNull();
    expect([...host.querySelectorAll('button')].some((b) => b.textContent?.includes('Connect to database'))).toBe(true);
  });
});

describe('bridge contract for the provider switch', () => {
  it('mssql-status carries the provider and the switch message validates', () => {
    expect(ExtensionToWebviewMsgSchema.safeParse({ type: 'mssql-status', available: true, provider: 'builtIn' }).success).toBe(true);
    expect(ExtensionToWebviewMsgSchema.safeParse({ type: 'mssql-status', available: true, provider: 'other' }).success).toBe(false);
    expect(MainPanelToExtensionMsgSchema.safeParse({ type: 'use-builtin-connection' }).success).toBe(true);
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
