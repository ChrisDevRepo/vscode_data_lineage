import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = mkdtempSync(join(tmpdir(), 'mcp-live-runner-'));
const bootstrap = join(work, 'bootstrap.mjs');
writeFileSync(bootstrap, `
import { mock } from 'node:test';
import { writeFileSync } from 'node:fs';
mock.module(${JSON.stringify(pathToFileURL(join(root, 'tests/tools/mcp/host.mjs')).href)}, { namedExports: {
  DEFAULT_PORT: 39372, USER_DATA: ${JSON.stringify(work)}, WORK: ${JSON.stringify(work)}, root: ${JSON.stringify(root)},
  fail4: message => { console.error(message); process.exit(4); },
  prepare: () => writeFileSync(${JSON.stringify(join(work, 'launched'))}, ''),
  launchHost: () => ({}), waitForReady: async () => ({ port: 39372, nodes: 1, discoveryPath: ${JSON.stringify(join(work, 'discovery'))} }),
  finishHost: async () => JSON.parse(process.env.TEST_HOST_EXIT), hostCommand: async () => ({}), waitFor: async fn => fn(),
} });
mock.module(${JSON.stringify(pathToFileURL(join(root, 'tests/tools/mcp/client.mjs')).href)}, { namedExports: {
  JSON_RPC_HEADERS: () => ({}), call: async () => ({}), connect: async () => ({}), raw: async () => ({}), seenTokens: new Set(),
  readDiscovery: () => ({ url: 'http://127.0.0.1:39372/mcp', token: 'a'.repeat(32) }),
} });
`);
writeFileSync(join(work, 'discovery'), '', { mode: 0o600 });

try {
  for (const [name, filter, hostExit, expected] of [
    ['rejects a filter matching no cases before launch', 'does-not-exist', 0, 4],
    ['accepts a successful selected case and host', 'discovery file is private', 0, 0],
    ['rejects an unsuccessful host after passing cases', 'discovery file is private', 2, 4],
    ['rejects a signalled host after passing cases', 'discovery file is private', null, 4],
  ]) {
    test(name, () => {
      rmSync(join(work, 'launched'), { force: true });
      const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--import', bootstrap, 'tests/tools/mcp-live.mjs', '--only', filter], {
        cwd: root, encoding: 'utf8', env: { ...process.env, TEST_HOST_EXIT: JSON.stringify(hostExit) },
      });
      assert.equal(result.status, expected, result.stdout + result.stderr);
      if (filter === 'does-not-exist') assert.throws(() => readFileSync(join(work, 'launched')), /ENOENT/);
    });
  }
  test.after(() => rmSync(work, { recursive: true, force: true }));
} catch (error) {
  rmSync(work, { recursive: true, force: true });
  throw error;
}
