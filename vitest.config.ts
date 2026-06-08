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
];

const uiTests = [
  'tests/unit/components/**/*.test.tsx',
  'tests/unit/hooks/**/*.test.tsx',
  'tests/unit/hooks/**/*.test.ts',
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
    projects: [
      defineProject({
        test: {
          name: 'parser',
          environment: 'node',
          include: [parserRunner],
        },
      }),
      defineProject({
        test: {
          name: 'bfs',
          environment: 'node',
          include: [bfsRunner],
        },
      }),
      defineProject({
        test: {
          name: 'support-node',
          environment: 'node',
          include: [supportRunner],
        },
      }),
      defineProject({
        resolve: nativeTestResolve,
        test: {
          name: 'support-ui',
          environment: 'jsdom',
          include: supportUiTests,
        },
      }),
      defineProject({
        resolve: nativeTestResolve,
        test: {
          name: 'ui',
          environment: 'jsdom',
          include: uiTests,
          exclude: supportUiTests,
        },
      }),
      defineProject({
        test: {
          name: 'baseline',
          environment: 'node',
          include: [baselineRunner],
        },
      }),
      defineProject({
        test: {
          name: 'snapshot',
          environment: 'node',
          include: [snapshotRunner],
        },
      }),
      defineProject({
        test: {
          name: 'snapshot-update',
          environment: 'node',
          include: [snapshotUpdateRunner],
        },
      }),
    ],
  },
});
