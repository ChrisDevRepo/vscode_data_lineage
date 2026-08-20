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
  },
});
