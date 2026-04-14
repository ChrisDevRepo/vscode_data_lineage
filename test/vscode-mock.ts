/**
 * Simple VS Code API Mock for Node.js tests.
 * Allows modules that import 'vscode' to be loaded in tsx/Node.
 */

export const window = {
    createWebviewPanel: () => ({
        webview: {
            onDidReceiveMessage: () => ({ dispose: () => {} }),
            postMessage: () => Promise.resolve(true),
            asWebviewUri: (uri: any) => uri,
            cspSource: 'vscode-resource:',
            html: ''
        },
        onDidDispose: () => ({ dispose: () => {} }),
        reveal: () => {},
        dispose: () => {}
    }),
    showInformationMessage: () => Promise.resolve(''),
    showErrorMessage: () => Promise.resolve(''),
    showWarningMessage: () => Promise.resolve(''),
    showOpenDialog: () => Promise.resolve(undefined),
    showSaveDialog: () => Promise.resolve(undefined),
    withProgress: (opts: any, task: any) => task({ report: () => {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) }),
    createOutputChannel: () => ({
        appendLine: () => {},
        show: () => {},
        dispose: () => {},
        info: () => {},
        debug: () => {},
        warn: () => {},
        error: () => {},
        trace: () => {}
    }),
    registerTreeDataProvider: () => ({ dispose: () => {} }),
};

export const workspace = {
    getConfiguration: () => ({
        get: (key: string, def: any) => def,
        update: () => Promise.resolve()
    }),
    fs: {
        readFile: () => Promise.resolve(new Uint8Array()),
        writeFile: () => Promise.resolve(),
    },
    workspaceFolders: [],
    onDidSaveTextDocument: () => ({ dispose: () => {} }),
};

export const commands = {
    executeCommand: () => Promise.resolve(),
    registerCommand: () => ({ dispose: () => {} }),
};

export const env = {
    openExternal: () => Promise.resolve(true),
    clipboard: {
        writeText: () => Promise.resolve(),
    },
    machineId: 'mock-machine-id',
};

export const Uri = {
    file: (path: string) => ({ fsPath: path, scheme: 'file' }),
    parse: (url: string) => ({ fsPath: url, scheme: url.split(':')[0] }),
    joinPath: (base: any, ...parts: string[]) => ({ fsPath: base.fsPath + '/' + parts.join('/'), scheme: base.scheme }),
};

export class TreeItem {
    constructor(public label: string, public collapsibleState: any) {}
}

export enum TreeItemCollapsibleState {
    None = 0,
    Collapsed = 1,
    Expanded = 2
}

export enum ViewColumn {
    One = 1,
    Two = 2,
    Beside = -2
}

export enum ColorThemeKind {
    Light = 1,
    Dark = 2,
    HighContrast = 3,
    HighContrastLight = 4
}

export class ThemeIcon {
    constructor(public id: string) {}
}

export enum FileType {
    Unknown = 0,
    File = 1,
    Directory = 2,
    SymbolicLink = 64
}

export class FileSystemError extends Error {
    static FileNotFound() { return new FileSystemError('File not found'); }
    code = 'FileNotFound';
}

export class EventEmitter {
    event = () => ({ dispose: () => {} });
    fire() {}
    dispose() {}
}

export const ExtensionContext = {};
