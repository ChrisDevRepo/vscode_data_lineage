import { loadTestEnv } from './tests/tools/load-test-env.mjs';
import { defineConfig } from '@vscode/test-cli';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const badge = process.argv.includes('badge');
const real = process.env.DLV_CHAT_UI_REAL === '1' || process.argv.includes('live') || badge;
let replayTrace;
if(badge) {
  const candidates=readdirSync('tmp/lm-trace').filter(name=>name.endsWith('.ndjson'))
    .map(name=>join('tmp/lm-trace',name)).sort((a,b)=>statSync(b).mtimeMs-statSync(a).mtimeMs);
  replayTrace=candidates.find(path=>{
    const responses=readFileSync(path,'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(row=>row.type==='wire-response');
    const start=responses.flatMap(row=>row.toolCalls??[]).find(call=>call.name==='lineage_start_exploration');
    return start?.input.origin?.toLowerCase()==='[ai].[spimportorders]' && start.input.classification==='both'
      && responses.some(row=>row.phase==='synthesis'&&row.toolCalls?.some(call=>call.name==='lineage_present_result'));
  });
  if(!replayTrace) throw new Error('Badge acceptance needs a recorded successful public AdventureWorks AI synthesis.');
  replayTrace=fileURLToPath(new URL(replayTrace,import.meta.url));
  console.log(`[chat-ui] badge setup replays recorded analysis: ${replayTrace}; only suggestion inference is live`);
}
if (real) {
  process.env.AI_TEST_PROVIDER = process.env.AI_TEST_PROVIDER || 'fireworks';
  const identity = loadTestEnv({requireAiProvider:true});
  if (identity.provider === 'fireworks' && !process.env.AI_TEST_MODEL.includes('/')) {
    process.env.AI_TEST_MODEL = `accounts/fireworks/models/${process.env.AI_TEST_MODEL}`;
  }
  console.log(`[chat-ui] live provider=${identity.provider} model=${process.env.AI_TEST_MODEL} reasoning=low temperature=0.1`);
}
const profile = mkdtempSync(join(tmpdir(), 'dlv-chat-ui-'));
const root = fileURLToPath(new URL('.', import.meta.url));
const cdpPort = process.env.PLAYWRIGHT_CDP_PORT || (real ? '9376' : '9377');
export default defineConfig({
  version: '1.140.0', label: badge ? 'badge' : real ? 'live' : 'fixture',
  files: 'out/test/tests/integration/chat-ui.test.js',
  extensionDevelopmentPath: [root, `${root}/tests/fixtures/lm-provider-extension`],
  launchArgs: [root, `--user-data-dir=${profile}`, '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
    '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${cdpPort}`],
  env: { DLV_CHAT_UI_FIXTURE: real ? undefined : '1', DLV_CHAT_UI_REAL: real ? '1' : undefined,
    AI_TEST_REAL_PROVIDER: real ? '1' : undefined, AI_TEST_REASONING_EFFORT: real ? 'low' : undefined,
    DLV_CHAT_UI_REPLAY_TRACE:replayTrace,
    PLAYWRIGHT_CDP_PORT: cdpPort },
  mocha: { ui: 'tdd', timeout: real ? 1200000 : 90000, color: true,
    ...(badge ? {grep:'live AI question'} : {}) },
});
