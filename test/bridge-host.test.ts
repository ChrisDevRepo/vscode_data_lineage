import * as vscode from 'vscode';
// Mock the 'vscode' module before importing panelProvider
const Module = require('module');
const originalLoad = Module._load;
const mockVscode = {
    window: {
        createOutputChannel: () => ({ appendLine: () => {} }),
        registerTreeDataProvider: () => {},
        createWebviewPanel: () => ({ webview: {} }),
    },
    workspace: {
        getConfiguration: () => ({ get: () => [] }),
        fs: {},
    },
    commands: {
        registerCommand: () => {},
        executeCommand: () => Promise.resolve(),
    },
    chat: {
        createChatParticipant: () => {},
    },
    EventEmitter: class {},
    TreeItem: class {},
    ThemeIcon: class {},
    Uri: { file: (p: string) => ({ fsPath: p, scheme: 'file' }), parse: (u: string) => ({ fsPath: u, scheme: u.split(':')[0] }), joinPath: (b: any, ...p: string[]) => ({ fsPath: b.fsPath + '/' + p.join('/') }) },
    ViewColumn: { One: 1 },
    ProgressLocation: { Notification: 1 },
};
Module._load = function(request: string, parent: any, isMain: boolean) {
    if (request === 'vscode') return mockVscode;
    return originalLoad.apply(this, arguments);
};

import { createMessageHandlers, BridgeHost } from '../src/panelProvider';
import { AiSession } from '../src/ai/session';

// ─── Mocks ───────────────────────────────────────────────────────────────────

class MockMemento {
    private data = new Map<string, any>();
    get<T>(key: string): T | undefined { return this.data.get(key); }
    update(key: string, value: any): Promise<void> {
        this.data.set(key, value);
        return Promise.resolve();
    }
    keys(): readonly string[] { return Array.from(this.data.keys()); }
}

const mockHost = (): BridgeHost & { messages: any[] } => {
    const messages: any[] = [];
    return {
        messages,
        postMessage: (msg) => { messages.push(msg); return Promise.resolve(true); },
        log: (lvl, cat, txt) => console.log(`[${lvl.toUpperCase()}] [${cat}] ${txt}`),
        showErrorMessage: (msg) => console.error(`[ERROR UI] ${msg}`),
        executeCommand: (cmd) => Promise.resolve(),
        openExternal: () => Promise.resolve(true),
        showOpenDialog: () => Promise.resolve(undefined),
        showSaveDialog: () => Promise.resolve(undefined),
        readFile: () => Promise.resolve(new Uint8Array()),
        writeFile: () => Promise.resolve(),
        withProgress: (opts, task) => task({ report: () => {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as any),
        getConfiguration: () => ({ get: () => [] }),
        getExtensionUri: () => ({ fsPath: '/mock' } as any),
        getGlobalState: () => new MockMemento(),
        getWorkspaceState: () => new MockMemento(),
    };
};

// ─── Test ────────────────────────────────────────────────────────────────────

async function testBridgeReady() {
    console.log('\n── Test: Bridge Ready ──');
    const host = mockHost();
    const handlers = createMessageHandlers(
        host,
        {} as any, // context
        () => new AiSession(),
        { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as any, // outputChannel
        () => ({ projects: [] }), // loadProjectStore
        () => Promise.resolve(), // saveProjectStore
        () => Promise.resolve(), // migrateFromWorkspaceState
        false, // loadDemo
        () => {} // setDetailPanel
    );

    try {
        await handlers['ready']({});
        console.log('SUCCESS: "ready" handler executed');
        const projectListMsg = host.messages.find(m => m.type === 'projects-list');
        if (projectListMsg) {
            console.log('SUCCESS: received projects-list message');
        } else {
            console.error('FAILED: projects-list message missing');
            process.exit(1);
        }
    } catch (err) {
        console.error('FAILED: "ready" handler crashed:', err);
        process.exit(1);
    }
}

testBridgeReady();
