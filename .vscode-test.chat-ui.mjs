import { defineConfig } from '@vscode/test-cli';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('.', import.meta.url));
const profile = mkdtempSync(join(tmpdir(), 'dlv-chat-ui-'));
// Seed accessibility mode before launch: switching it at runtime on Linux restarts the window and ends the run.
mkdirSync(join(profile, 'User'), { recursive: true });
writeFileSync(
  join(profile, 'User', 'settings.json'),
  JSON.stringify({ 'editor.accessibilitySupport': 'on' }),
);
const cdpPort = process.env.PLAYWRIGHT_CDP_PORT || '9377';
export default defineConfig({
  version: '1.141.0',
  label: 'fixture',
  files: 'out/test/tests/integration/chat-ui.test.js',
  extensionDevelopmentPath: [
    root,
    `${root}/tests/fixtures/lm-provider-extension`,
  ],
  launchArgs: [
    root,
    `--user-data-dir=${profile}`,
    '--disable-extensions',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-workspace-trust',
    '--log=debug',
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${cdpPort}`,
  ],
  env: {
    DLV_CHAT_UI_PROFILE: profile,
    DLV_CHAT_UI_FIXTURE: '1',
    DLV_CHAT_UI_REAL: undefined,
    AI_TEST_REAL_PROVIDER: undefined,
    DLV_CHAT_UI_REPLAY_TRACE: undefined,
    PLAYWRIGHT_CDP_PORT: cdpPort,
  },
  mocha: {
    ui: 'tdd',
    failZero: true,
    timeout: 90000,
    color: true,
  },
});
