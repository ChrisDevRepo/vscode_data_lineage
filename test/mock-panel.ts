import * as vscode from 'vscode';
import { openPanel } from '../src/panelProvider';
import { AiSession } from '../src/ai/session';

// Mock objects
const mockContext: any = {
    extensionUri: { fsPath: '/mock/uri' },
    subscriptions: [],
    globalState: {
        get: () => undefined,
        update: () => Promise.resolve()
    },
    workspaceState: {
        get: () => undefined,
        update: () => Promise.resolve()
    }
};

const mockOutputChannel: any = {
    info: (msg: string) => console.log(`[INFO] ${msg}`),
    debug: (msg: string) => console.log(`[DEBUG] ${msg}`),
    warn: (msg: string) => console.log(`[WARN] ${msg}`),
    error: (msg: string) => console.log(`[ERROR] ${msg}`),
    trace: (msg: string) => console.log(`[TRACE] ${msg}`)
};

const mockWebview: any = {
    postMessage: (msg: any) => console.log(`[WEBVIEW] Received: ${JSON.stringify(msg)}`),
    onDidReceiveMessage: (handler: (msg: any) => void) => {
        console.log('[MOCK] onDidReceiveMessage registered');
        return { dispose: () => {} };
    },
    asWebviewUri: (uri: any) => uri,
    html: ''
};

const mockPanel: any = {
    webview: mockWebview,
    onDidDispose: () => {},
    reveal: () => {}
};

// Simulate opening the panel
console.log('--- Simulating openPanel ---');
openPanel(
    mockContext,
    'Test Panel',
    () => new AiSession(),
    mockOutputChannel,
    () => ({ projects: [] }),
    () => Promise.resolve(),
    () => Promise.resolve()
);

// We need to capture the handler to simulate messages.
// Since we can't easily capture it from here without modifying src, 
// let's just do a manual check of the logic.
