import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { isIsolatedWorkbenchPage, validateGuiSession } from './gui-test-host.mjs';
import { loadTestEnv } from './load-test-env.mjs';
import { loadCases } from '../cases/loadCases.cjs';

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
  let workbench;
  const workbenchDeadline = Date.now() + 15_000;
  while (!workbench && Date.now() < workbenchDeadline) {
    for (const page of browser.contexts().flatMap((context) => context.pages())) {
      const title = await page.title().catch(() => '');
      if (isIsolatedWorkbenchPage({ title, url: page.url() }, session, resolve('.vscode-test'))) {
        workbench = page;
        break;
      }
    }
    if (!workbench) await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  assert.ok(
    workbench,
    `The CDP endpoint did not expose the isolated ${session.workspaceName} VS Code workbench.`,
  );
  await workbench.locator('.monaco-workbench').waitFor({ state: 'visible', timeout: 15_000 });
  await workbench.getByRole('tab', { name: 'Data Lineage', exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
  const rows = loadCases('playwright');
  assert.ok(rows.length > 0, 'tests/cases/lineage-cases.yaml has no playwright row.');
  for (const row of rows) {
    assert.equal(row.expect?.graph, true, `${row.id} expects a rendered graph.`);
    const command = row.command;
    assert.equal(typeof command, 'string', `${row.id} needs a command.`);
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await workbench.keyboard.press(`${modifier}+Shift+P`);
    const commandInput = workbench.locator('.quick-input-widget input').first();
    await commandInput.waitFor({ state: 'visible', timeout: 10_000 });
    await commandInput.fill(`>${command}`);
    const commandItem = workbench
      .locator('.quick-input-list .monaco-list-row')
      .filter({ hasText: command })
      .first();
    await commandItem.waitFor({ state: 'visible', timeout: 10_000 });
    assert.match(
      (await commandItem.innerText()).replace(/\s+/gu, ' ').trim(),
      new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'),
      `${row.id}: the command palette must offer ${command} before execution.`,
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
      if (!graphVisible) await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
    assert.ok(graphVisible, `${row.id}: the command must render a React Flow graph.`);
    console.log(`PASS: ${row.id}`);
  }
} finally {
  // For connectOverCDP, Playwright closes its transport; the runner owns the host lifecycle.
  await browser.close();
}
