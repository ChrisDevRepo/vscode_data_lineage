import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, defineProject } from 'vitest/config';

// `vscode` only exists in the extension host; alias it to a stub so source files
// that import it (e.g. src/utils/notifications.ts) resolve under unit tests.
// vitest 4 inline projects do not inherit the root `resolve`, so apply this on each
// native-vitest (jsdom) project that loads vscode-importing source.
const vscodeStub = fileURLToPath(new URL('./tests/stubs/vscode.ts', import.meta.url));
const nativeTestResolve = { alias: { vscode: vscodeStub } };

const parserRunner = 'tests/unit/runners/parser.test.ts';
const bfsRunner = 'tests/unit/runners/bfs.test.ts';
const supportRunner = 'tests/unit/runners/support.test.ts';
const baselineRunner = 'tests/unit/runners/baseline.test.ts';
const snapshotRunner = 'tests/unit/runners/snapshot.test.ts';
const snapshotUpdateRunner = 'tests/unit/runners/snapshot-update.test.ts';

const supportUiTests = [
  'tests/unit/hooks/modeCapabilities.test.ts',
  // Native describe/it + vi.mock('vscode') — runs here, not via the node-suite wrapper.
  'tests/unit/notifications.test.ts',
  // Imports participantUtils (which imports `vscode`); needs the stub alias.
  'tests/unit/present-result-error-code.test.ts',
  // Imports participantUtils builders; needs the stub alias.
  'tests/unit/minimal-tool-pair.test.ts',
];

const uiTests = [
  'tests/unit/components/**/*.test.tsx',
  'tests/unit/hooks/**/*.test.tsx',
  'tests/unit/hooks/**/*.test.ts',
];

interface ProjectSpec {
  name: string;
  include: string[];
  /** Defaults to 'node'. */
  environment?: 'node' | 'jsdom';
  exclude?: string[];
  /** jsdom projects loading vscode-importing source need the stub alias. */
  resolve?: typeof nativeTestResolve;
}

const projectSpecs: ProjectSpec[] = [
  { name: 'parser', include: [parserRunner] },
  { name: 'bfs', include: [bfsRunner] },
  { name: 'support-node', include: [supportRunner] },
  { name: 'support-ui', include: supportUiTests, environment: 'jsdom', resolve: nativeTestResolve },
  { name: 'ui', include: uiTests, environment: 'jsdom', exclude: supportUiTests, resolve: nativeTestResolve },
  { name: 'baseline', include: [baselineRunner] },
  { name: 'snapshot', include: [snapshotRunner] },
  { name: 'snapshot-update', include: [snapshotUpdateRunner] },
];

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify('test'),
  },
  test: {
    globals: true,
    coverage: {
      provider: 'v8',
      include: ['src/engine/**', 'src/hooks/**'],
      reporter: ['text', 'html'],
    },
    projects: projectSpecs.map(({ name, include, environment = 'node', exclude, resolve }) =>
      defineProject({
        ...(resolve ? { resolve } : {}),
        test: { name, environment, include, ...(exclude ? { exclude } : {}) },
      })),
  },
});
