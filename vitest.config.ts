import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// `vscode` only exists in the extension host; alias it to a stub so source files
// that import it resolve under unit tests.
const vscodeStub = fileURLToPath(new URL('./tests/stubs/vscode.ts', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { vscode: vscodeStub } },
  define: {
    __APP_VERSION__: JSON.stringify('test'),
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // Scoped to the deterministic core — SQL parsing and graph/BFS. A repo-wide number
      // would let well-covered surfaces mask a gap here, and would make the threshold move
      // for reasons unrelated to the code it is meant to protect.
      include: [
        'src/engine/sqlBodyParser.ts',
        'src/engine/graphAnalysis.ts',
        'src/engine/graphBuilder.ts',
        'src/engine/shared/sqlRegex.ts',
        'src/engine/shared/nodeIdResolution.ts',
      ],
      // Counts modules with no test at all, rather than reporting only what was imported.
      all: true,
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'test-results/coverage-core',
      // Per-file floors, measured from an observed run and raised only when a later run
      // clears the higher number. Deliberately not a single repo-wide number: one aggregate
      // lets a well-covered module offset a bare one, which is the failure this is meant to
      // catch. `graphBuilder.ts` sits far below its siblings — that floor records the gap
      // rather than excusing it, and exists to stop it widening.
      thresholds: {
        '**/src/engine/graphAnalysis.ts': { statements: 99, branches: 88, functions: 100, lines: 100 },
        '**/src/engine/sqlBodyParser.ts': { statements: 88, branches: 81, functions: 100, lines: 94 },
        '**/src/engine/graphBuilder.ts': { statements: 84, branches: 70, functions: 85, lines: 87 },
        '**/src/engine/shared/sqlRegex.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
        '**/src/engine/shared/nodeIdResolution.ts': { statements: 92, branches: 75, functions: 100, lines: 100 },
      },
    },
  },
});
