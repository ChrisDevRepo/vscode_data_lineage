/**
 * Bundle Sanity Check
 * Attempts to load the bundled extension in a Node.js environment with a VS Code mock.
 * This catches ReferenceErrors (like missing imports) early.
 */

const mockVscode = {
    window: {
        createOutputChannel: () => ({ 
            appendLine: () => {}, 
            show: () => {},
            info: () => {},
            debug: () => {},
            warn: () => {},
            error: () => {},
            trace: () => {}
        }),
        registerTreeDataProvider: () => {},
        createWebviewPanel: () => ({ webview: {}, onDidDispose: () => {} }),
        showErrorMessage: () => {},
        showInformationMessage: () => {},
        showWarningMessage: () => {},
        withProgress: (opts, task) => task({ report: () => {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) }),
    },
    workspace: {
        getConfiguration: () => ({ 
            get: (key, def) => def,
            update: () => Promise.resolve()
        }),
        fs: {
            readFile: () => Promise.resolve(new Uint8Array()),
            copy: () => Promise.resolve(),
            stat: () => Promise.resolve({}),
        },
        workspaceFolders: [],
        onDidChangeConfiguration: () => ({ dispose: () => {} }),
        openTextDocument: () => Promise.resolve({}),
    },
    commands: {
        registerCommand: () => {},
        executeCommand: () => Promise.resolve(),
    },
    chat: {
        createChatParticipant: () => ({
            onDidReceiveFeedback: () => {},
            followupProvider: {}
        }),
    },
    env: {
        openExternal: () => Promise.resolve(true),
        clipboard: { writeText: () => Promise.resolve() },
    },
    EventEmitter: class { event = () => ({ dispose: () => {} }); fire() {} },
    TreeItem: class {},
    ThemeIcon: class {},
    Uri: { 
        file: (p) => ({ fsPath: p, scheme: 'file' }), 
        parse: (u) => ({ fsPath: u, scheme: u.split(':')[0] }), 
        joinPath: (b, ...p) => ({ fsPath: (b.fsPath || b) + '/' + p.join('/') }) 
    },
    ViewColumn: { One: 1, Beside: -2 },
    ProgressLocation: { Notification: 1 },
    LanguageModelChatMessage: {
        User: (c) => ({ role: 'user', content: c }),
        Assistant: (c) => ({ role: 'assistant', content: c }),
    },
    LanguageModelChatMessageRole: { User: 1, Assistant: 2 }
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
    require('../out/extension.js');
    console.log('SUCCESS: Bundle loaded without immediate ReferenceErrors.');
} catch (err) {
    console.error('FAILED: Bundle sanity check failed!');
    console.error(err);
    process.exit(1);
}
