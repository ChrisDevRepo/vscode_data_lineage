import { defineConfig } from '@vscode/test-cli';

// Official VS Code integration-test runner (L2/L3 in docs/E2E_TESTING.md).
// Tests run inside a real Extension Development Host with the full `vscode` API.
// `--remote-debugging-port` lets a test also read the rendered webview over CDP;
// `VSCODE_EX_TEST` enables the in-memory `testLogCapture` log buffer (utils/log.ts).
export default defineConfig({
  label: 'integration',
  files: 'out/test/integration/**/*.test.js',
  version: 'stable',
  launchArgs: [
    '--disable-extensions',
    '--remote-debugging-port=9222',
  ],
  env: {
    VSCODE_EX_TEST: '1',
  },
  mocha: {
    ui: 'tdd',
    timeout: 60000,
    color: true,
  },
});
