import { register } from 'module';
import { pathToFileURL } from 'url';
import * as mockVscode from './vscode-mock';

// Hijack 'vscode' module import
const originalLoad = (global as any).Module?._load;
if ((global as any).Module) {
    (global as any).Module._load = function (request: string, parent: any, isMain: boolean) {
        if (request === 'vscode') return mockVscode;
        return originalLoad.apply(this, arguments);
    };
}

// For ESM (tsx uses loaders)
// This is harder but let's try the common JS way first as tsx often falls back to it.
