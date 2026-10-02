import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { isIsolatedWorkbenchPage, validateGuiSession } from './gui-test-host.mjs';
import { loadTestEnv } from './load-test-env.mjs';

loadTestEnv();
const sessionFile = resolve('.vscode-test/gui-host-session.json');
let session;
try {
  session = validateGuiSession(JSON.parse(readFileSync(sessionFile, 'utf8')));
} catch (error) {
  throw new Error(`Start npm run test:gui:host first; its active session marker is required. ${error.message}`);
}
if (process.env.PLAYWRIGHT_CDP_URL) {
  assert.equal(
    process.env.PLAYWRIGHT_CDP_URL,
    session.endpoint,
    'PLAYWRIGHT_CDP_URL must match the isolated GUI test host session.',
  );
}
try {
  process.kill(session.pid, 0);
} catch {
  throw new Error('The isolated GUI test host recorded in the session marker is no longer running.');
}

const browser = await chromium.connectOverCDP(session.endpoint, { timeout: 10_000 });
try {
  const pages = browser.contexts().flatMap((context) => context.pages());
  let workbench;
  for (const page of pages) {
    const title = await page.title().catch(() => '');
    if (isIsolatedWorkbenchPage({ title, url: page.url() }, session, resolve('.vscode-test'))) {
      workbench = page;
      break;
    }
  }
  assert.ok(
    workbench,
    `The CDP endpoint did not expose the isolated ${session.workspaceName} VS Code workbench.`,
  );
  await workbench.locator('.monaco-workbench').waitFor({ state: 'visible', timeout: 15_000 });
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await workbench.keyboard.press(`${modifier}+Shift+P`);
  const commandInput = workbench.locator('.quick-input-widget input').first();
  await commandInput.waitFor({ state: 'visible', timeout: 10_000 });
  await commandInput.fill('>Data Lineage: Open Demo');
  const commandItem = workbench
    .locator('.quick-input-list .monaco-list-row')
    .filter({ hasText: 'Data Lineage: Open Demo' })
    .first();
  await commandItem.waitFor({ state: 'visible', timeout: 10_000 });
  assert.match(
    (await commandItem.innerText()).replace(/\s+/gu, ' ').trim(),
    /Data Lineage: Open Demo/u,
    'the command palette must offer the Data Lineage: Open Demo command before execution.',
  );
  await commandInput.press('Enter');

  const deadline = Date.now() + 30_000;
  let graphVisible = false;
  while (Date.now() < deadline && !graphVisible) {
    for (const frame of workbench.frames()) {
      if (await frame.locator('.react-flow__viewport').isVisible().catch(() => false)) {
        graphVisible = true;
        break;
      }
    }
    if (!graphVisible) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(graphVisible, 'the demo command must render a React Flow graph in the workbench.');
  console.log('PASS: VS Code workbench opened the demo lineage graph through its command palette.');
} finally {
  // For connectOverCDP, Playwright closes its transport; the runner owns the host lifecycle.
  await browser.close();
}
