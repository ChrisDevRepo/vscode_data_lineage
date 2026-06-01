import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, vi } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const unitDir = path.resolve(__dirname, '..');
const MODULE_IMPORT_TIMEOUT_MS = 30000;

function moduleLabel(relativePath: string): string {
  return path.basename(relativePath);
}

export function discoverUnitTestFiles(exclude: string[] = []): string[] {
  const excluded = new Set(exclude);

  return readdirSync(unitDir)
    .filter((name) => name.endsWith('.test.ts'))
    .filter((name) => !excluded.has(name))
    .sort((left, right) => left.localeCompare(right));
}

export function registerModuleSuites(relativePaths: string[]): void {
  for (const relativePath of [...relativePaths].sort((left, right) => left.localeCompare(right))) {
    test(moduleLabel(relativePath), async () => {
      vi.resetModules();
      const moduleUrl = pathToFileURL(path.resolve(unitDir, relativePath)).href;
      await import(moduleUrl);
    }, MODULE_IMPORT_TIMEOUT_MS);
  }
}
