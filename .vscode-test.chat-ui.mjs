import { loadTestEnv } from './tests/tools/load-test-env.mjs';
import { badgeReplayTrace } from './tests/tools/chat-ui-replay-trace.mjs';
import { defineConfig } from '@vscode/test-cli';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('.', import.meta.url));
const badge = process.argv.includes('badge');
const column = process.argv.includes('column') || Boolean(process.env.DLV_CHAT_UI_CASE_FILE);
if (column) {
  if (!process.env.DLV_CHAT_UI_CASE_FILE) throw new Error('column requires DLV_CHAT_UI_CASE_FILE with one declared catalog CT case.');
  const row = JSON.parse(readFileSync(process.env.DLV_CHAT_UI_CASE_FILE, 'utf8'));
  if (typeof row.id !== 'string' || typeof row.prompt !== 'string' || typeof row.dacpac !== 'string' || !existsSync(row.dacpac)
    || typeof row.startingPoint?.node !== 'string' || typeof row.startingPoint?.column !== 'string'
    || row.expect?.approval?.analysisMode !== 'ct' || !['business', 'technical', 'both'].includes(row.expect.approval.classification) || !row.expect.approval.depthIntent) throw new Error('Invalid declared native CT case.');
  if (process.env.DLV_CHAT_UI_REPLAY_TRACE) throw new Error('Native CT acceptance uses fresh actual inference, never replay.');
}
const real = process.env.DLV_CHAT_UI_REAL === '1' || process.argv.includes('live') || badge || column;
if (process.env.AI_TEST_BASELINE !== undefined && !['0', '1'].includes(process.env.AI_TEST_BASELINE)) {
  throw new Error('AI_TEST_BASELINE must be 0 or 1.');
}
let replayTrace;
if(badge) {
  replayTrace=badgeReplayTrace(root, process.env.DLV_CHAT_UI_BADGE_LIVE);
  console.log(replayTrace
    ? `[chat-ui] badge setup replays recorded analysis: ${replayTrace}; only suggestion inference is live`
    : '[chat-ui] badge setup runs fresh real-model analysis; suggestion inference is also live');
}
if (real) {
  const identity = loadTestEnv({requireAiProvider:true});
  for (const key of ['LANGFUSE_BASE_URL', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY']) {
    if (!process.env[key]?.trim()) throw new Error(`Set ${key} before a live native chat run.`);
  }
  if (identity.provider === 'fireworks' && !process.env.AI_TEST_MODEL.includes('/')) {
    process.env.AI_TEST_MODEL = `accounts/fireworks/models/${process.env.AI_TEST_MODEL}`;
  }
  console.log(`[chat-ui] live provider=${identity.provider} model=${process.env.AI_TEST_MODEL} reasoning=low temperature=0.1`);
}
const profile = mkdtempSync(join(tmpdir(), 'dlv-chat-ui-'));
// Seed accessibility mode before launch: switching it at runtime on Linux restarts the window and ends the run.
mkdirSync(join(profile, 'User'), { recursive: true });
writeFileSync(join(profile, 'User', 'settings.json'), JSON.stringify({ 'editor.accessibilitySupport': 'on' }));
const providerProfile = real ? { provider: process.env.AI_TEST_PROVIDER, model: process.env.AI_TEST_MODEL, reasoningEffort: 'low' } : undefined;
if (providerProfile) writeFileSync(join(profile, 'provider-profile.json'), JSON.stringify(providerProfile));
const cdpPort = process.env.PLAYWRIGHT_CDP_PORT || (real ? '9376' : '9377');
export default defineConfig({
  version: '1.141.0', label: badge ? 'badge' : column ? 'column' : real ? 'live' : 'fixture',
  files: 'out/test/tests/integration/chat-ui.test.js',
  extensionDevelopmentPath: [root, `${root}/tests/fixtures/lm-provider-extension`],
  launchArgs: [root, `--user-data-dir=${profile}`, '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--log=debug',
    '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${cdpPort}`],
  env: { DLV_CHAT_UI_CASE_FILE: process.env.DLV_CHAT_UI_CASE_FILE, DLV_CHAT_UI_PROFILE: profile, DLV_CHAT_UI_PROVIDER_PROFILE: providerProfile ? JSON.stringify(providerProfile) : undefined, DLV_CHAT_UI_FIXTURE: real ? undefined : '1', DLV_CHAT_UI_REAL: real ? '1' : undefined,
    AI_TEST_PROVIDER: process.env.AI_TEST_PROVIDER,
    AI_TEST_MODEL: process.env.AI_TEST_MODEL,
    AI_TEST_REAL_PROVIDER: real ? '1' : undefined, AI_TEST_REASONING_EFFORT: real ? 'low' : undefined,
    DLV_CHAT_UI_REPLAY_TRACE:replayTrace,
    PLAYWRIGHT_CDP_PORT: cdpPort },
  mocha: { ui: 'tdd', failZero: true, timeout: real ? Number(process.env.AI_TEST_TIMEOUT_MS) + 60_000 : 90000, color: true,
    ...(badge ? {grep:'live AI question'} : column ? {grep:'live column trace'} : {}) },
});
