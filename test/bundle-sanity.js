/**
 * Bundle Sanity Check
 * Attempts to load the bundled extension in a Node.js environment with a VS Code mock.
 * This catches ReferenceErrors (like missing imports) early.
 */

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
    },
    chat: {
        createChatParticipant: () => {},
    },
    EventEmitter: class {},
    TreeItem: class {},
    ThemeIcon: class {},
    Uri: { file: (p) => p, parse: (u) => u, joinPath: (b, ...p) => ({ fsPath: b.fsPath + '/' + p.join('/') }) },
    ViewColumn: { One: 1 },
    ProgressLocation: { Notification: 1 },
};

// Hijack Module._load to return the mock when 'vscode' is requested
const Module = require('module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
    if (request === 'vscode') {
        return mockVscode;
    }
    return originalLoad.apply(this, arguments);
};

try {
    console.log('--- Starting Bundle Sanity Check ---');
    // Load the bundled extension
    // We expect it to fail if there are ReferenceErrors in the top-level scope
    require('../out/extension.js');
    console.log('SUCCESS: Bundle loaded without immediate ReferenceErrors.');
} catch (err) {
    console.error('FAILED: Bundle sanity check failed!');
    console.error(err);
    process.exit(1);
}
