/// <reference lib="dom" />
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { copyNativeHostLog } from '../harness/nativeEvidence';
interface SessionProjection {
  model: { nodes: Array<{ id: string }> } | null;
  phase: { kind: string };
  memory: { getResult(): { detail_slots: unknown[] } };
  pendingExploration: {
    revision: number;
    init: {
      depthIntent: {
        upstream: {
          levels: number | 'all';
          exactness: 'exact' | 'approximate';
        };
        downstream: {
          levels: number | 'all';
          exactness: 'exact' | 'approximate';
        };
      };
    };
  } | null;
  lastPresentResultDescription: string | null;
  stateMachine: { getResult(): unknown; toJSON(): unknown } | null;
}
import {
  chromium,
  type Browser,
  type Page,
  type Locator,
} from 'playwright-core';

/** Opt-in Playwright test of native chat controls in a real isolated Electron host. */
suite('Native chat confirmations — actual UI', () => {
  let browser: Browser;
  let page: Page;
  let exports: { getSession(): SessionProjection };
  const phaseTimeoutMs = 180000;
  const catalogPath = [
    join(__dirname, '..', 'cases', 'loadCases.cjs'),
    join(__dirname, '..', '..', '..', '..', 'tests', 'cases', 'loadCases.cjs'),
  ].find((path) => existsSync(path));
  if (!catalogPath)
    throw new Error(
      'tests/cases/loadCases.cjs was not found from the chat-ui test.',
    );
  const fixtureTrace = (
    createRequire(catalogPath)(catalogPath) as {
      loadCases: (
        runner?: string,
      ) => Array<{ id: string; prompt?: string; expect?: { phase?: string } }>;
    }
  )
    .loadCases('electron')
    .find((row) => row.id === 'electron-fixture-trace');
  if (!fixtureTrace?.prompt || !fixtureTrace.expect?.phase) {
    throw new Error(
      'electron-fixture-trace needs a prompt and expect.phase in tests/cases/lineage-cases.yaml',
    );
  }
  const fixturePrompt = fixtureTrace.prompt;
  const planPhase = fixtureTrace.expect.phase;
  const artifactDir = 'tmp/chat-ui/fixture';
  const copyHostLog = () => {
    try {
      copyNativeHostLog(process.env.DLV_CHAT_UI_PROFILE, artifactDir);
    } catch {
      /* Fixture evidence is best effort. */
    }
  };
  let fixture: {
    uiRequests: Array<{ messages: unknown; tools: Array<{ name: string }> }>;
  };
  const deadlineWait = async (predicate: () => boolean, label: string) => {
    const deadline = Date.now() + 20000;
    while (!predicate() && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(predicate(), label);
  };
  const waitForControl = (locator: Locator, timeout = phaseTimeoutMs) =>
    locator.waitFor({ state: 'visible', timeout });
  const input = () =>
    page.locator('.interactive-session [role="textbox"]').last();
  const idleInput = () =>
    waitForControl(
      page.getByRole('button', { name: /^Send \[/ }).last(),
      20000,
    );
  const send = async (text: string) => {
    await idleInput();
    const before = fixture.uiRequests.length;
    const box = input();
    await waitForControl(box, 20000);
    assert.notEqual(
      await box.getAttribute('aria-readonly'),
      'true',
      'input must accept a typed turn',
    );
    await page.keyboard.press('Escape');
    await page.locator('.interactive-session .monaco-editor').last().click();
    await box.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    // Paste through VS Code's actual editor: CDP key transport drops EditContext spaces.
    await vscode.env.clipboard.writeText(text);
    await box.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
    await page.waitForFunction(
      (expected) => {
        const editors = document.querySelectorAll(
          '.interactive-session [role="textbox"]',
        );
        const editor = editors[editors.length - 1];
        return (
          (editor instanceof HTMLTextAreaElement
            ? editor.value
            : editor?.textContent) === expected
        );
      },
      text,
      { timeout: 5000 },
    );
    await page.keyboard.press('Escape');
    assert.equal(
      await box.evaluate((el) =>
        el instanceof HTMLTextAreaElement ? el.value : el.textContent,
      ),
      text,
      'the real input must contain exactly the user message',
    );
    await page.keyboard.press('Enter');
    await deadlineWait(
      () => fixture.uiRequests.length > before,
      'Enter must dispatch a request to the selected model',
    );
  };
  const approveOnce = async () => {
    await idleInput();
    await continueButton().click();
  };
  const renderedPlan = () => {
    const revision = exports?.getSession().pendingExploration?.revision;
    return revision && revision > 1
      ? responses().filter({
          has: page.getByRole('heading', {
            name: `Exploration plan · revision ${revision}`,
            exact: true,
          }),
        })
      : page;
  };
  const continueButton = () =>
    renderedPlan()
      .getByRole('button', { name: /Approve & Proceed/ })
      .last();
  const changeScopeButton = () =>
    renderedPlan()
      .getByRole('button', { name: /Change scope/ })
      .last();
  const cancelButton = () =>
    renderedPlan()
      .getByRole('button', { name: /Cancel$/ })
      .last();
  const responses = () =>
    page.locator('.interactive-session .interactive-response');
  const capture = async (name: string) => {
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      `${artifactDir}/${name}.txt`,
      await page.locator('.interactive-session').last().innerText(),
    );
    await page.screenshot({ path: `${artifactDir}/${name}.png` });
    copyHostLog();
  };
  const captureCompletedResult = (name: string) => {
    const machine = exports.getSession().stateMachine;
    assert.ok(machine, 'a completed trace must retain its state machine');
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      `${artifactDir}/${name}-sm-state.json`,
      JSON.stringify(machine.toJSON(), null, 2),
    );
    writeFileSync(
      `${artifactDir}/${name}-result.json`,
      JSON.stringify(machine.getResult(), null, 2),
    );
    copyHostLog();
  };
  const newChat = async () => {
    await idleInput();
    await page.getByRole('button', { name: /^New Chat \(/ }).click();
    await idleInput();
  };
  const openPlan = async () => {
    await newChat();
    await send(fixturePrompt);
    await idleInput();
    assert.equal(exports.getSession().phase.kind, planPhase);
    await waitForControl(continueButton());
    assert.equal(
      exports.getSession().memory.getResult().detail_slots.length,
      0,
      'plan cannot run before approval',
    );
    await waitForControl(changeScopeButton(), 20000);
    await waitForControl(cancelButton(), 20000);
  };

  suiteSetup(async function () {
    await vscode.workspace
      .getConfiguration('editor')
      .update('accessibilitySupport', 'on', vscode.ConfigurationTarget.Global);
    fixture = await vscode.extensions
      .getExtension('data-lineage-test.data-lineage-test-model-provider')!
      .activate();
    assert.ok(
      (await vscode.lm.selectChatModels({ vendor: 'lineage-test' })).length,
      'scripted provider must resolve',
    );
    exports = await vscode.extensions
      .getExtension('datahelper-chwagner.data-lineage-viz')!
      .activate();
    browser = await chromium.connectOverCDP(
      `http://127.0.0.1:${process.env.PLAYWRIGHT_CDP_PORT}`,
    );
    page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((p) => p.url().includes('workbench'))!;
    assert.ok(page, 'CDP must attach to the test workbench');
    await vscode.commands.executeCommand('dataLineageViz.openDemo');
    await deadlineWait(
      () => !!exports.getSession().model,
      'public demo must finish loading',
    );
    await vscode.commands.executeCommand('workbench.action.chat.open', {
      query: fixturePrompt,
      isPartialQuery: true,
    });
    // Choose the contributed fixture via the real model picker; no provider credentials.
    await vscode.commands.executeCommand('notifications.clearAll');
    await vscode.commands.executeCommand('notifications.hideToasts');
    await page
      .locator('.notifications-toasts.visible')
      .waitFor({ state: 'hidden' });
    const picker = page
      .getByRole('button', {
        name: /^Models|Pick Model|Select Model|Model Picker/i,
      })
      .last();
    await picker.click();
    await page.getByText('Lineage Smoke Model', { exact: true }).last().click();
    await page.keyboard.press('Escape');
  });

  test('Cancel button discards the plan without analyzing; stale Approve is ignored', async () => {
    await openPlan();
    const before = fixture.uiRequests.length;
    await cancelButton().click();
    await page
      .getByText('Exploration cancelled.', { exact: true })
      .last()
      .waitFor({ timeout: 20000 });
    await idleInput();
    assert.equal(exports.getSession().pendingExploration, null);
    assert.equal(exports.getSession().phase.kind, 'idle');
    assert.equal(
      fixture.uiRequests.length,
      before,
      'button cancellation spends no model call',
    );
    await continueButton().click();
    const settleUntil = Date.now() + 1000;
    while (Date.now() < settleUntil) {
      assert.equal(
        exports.getSession().phase.kind,
        'idle',
        'stale approval must leave the session idle',
      );
      assert.equal(
        exports.getSession().pendingExploration,
        null,
        'stale approval must not restore a proposal',
      );
      assert.equal(
        fixture.uiRequests.length,
        before,
        'stale approval must not run',
      );
      assert.equal(
        exports.getSession().memory.getResult().detail_slots.length,
        0,
        'stale approval must not start analysis',
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await capture('cancel-button');
  });

  for (const reply of ['no', 'stop', 'no stop'])
    test(`typed "${reply}" cancels without clicking a button`, async () => {
      await openPlan();
      const before = fixture.uiRequests.length;
      await send(`@lineage ${reply}`);
      await page
        .getByText('Exploration cancelled.', { exact: true })
        .last()
        .waitFor({ timeout: phaseTimeoutMs });
      await idleInput();
      assert.ok(
        fixture.uiRequests.length > before,
        'typed cancellation must reach AI',
      );
      assert.equal(exports.getSession().pendingExploration, null);
      assert.equal(exports.getSession().phase.kind, 'idle');
      assert.equal(
        exports.getSession().memory.getResult().detail_slots.length,
        0,
      );
      await capture(`typed-${reply.replace(/ /g, '-')}`);
    });

  test('typed scope change revises the plan without clicking Change scope', async () => {
    await openPlan();
    await send(
      '@lineage change scope to one level upstream and zero levels downstream',
    );
    await idleInput();
    assert.equal(exports.getSession().pendingExploration?.revision, 2);
    assert.deepEqual(
      exports.getSession().pendingExploration?.init.depthIntent,
      {
        upstream: { levels: 1, exactness: 'exact' },
        downstream: { levels: 0, exactness: 'exact' },
      },
      'typed scope change must change the actual depth bounds',
    );
    assert.equal(exports.getSession().phase.kind, planPhase);
    assert.equal(
      exports.getSession().memory.getResult().detail_slots.length,
      0,
    );
    await waitForControl(continueButton(), 20000);
    await waitForControl(changeScopeButton(), 20000);
    await cancelButton().click();
    await idleInput();
    await capture('typed-scope-change');
  });

  test('typed approve starts analysis without clicking Approve', async () => {
    await openPlan();
    const before = fixture.uiRequests.length;
    await send('@lineage approve');
    await deadlineWait(
      () => exports.getSession().phase.kind === 'completed',
      'typed approve must complete analysis',
    );
    await idleInput();
    assert.ok(
      fixture.uiRequests.length > before,
      'typed approval must reach AI',
    );
    assert.equal(exports.getSession().pendingExploration, null);
    assert.ok(exports.getSession().memory.getResult().detail_slots.length > 0);
    assert.ok(
      exports.getSession().lastPresentResultDescription,
      'typed approval must synthesize a visible result',
    );
    captureCompletedResult('typed-approve');
    await capture('typed-approve');
  });

  suiteTeardown(async () => {
    mkdirSync(artifactDir, { recursive: true });
    if (page) {
      writeFileSync(
        `${artifactDir}/aria.txt`,
        await page.locator('.interactive-session').last().ariaSnapshot(),
      );
      writeFileSync(
        `${artifactDir}/chat.txt`,
        await page.locator('.interactive-session').last().innerText(),
      );
      await page.screenshot({ path: `${artifactDir}/workbench.png` });
    }
    writeFileSync(
      `${artifactDir}/requests.json`,
      JSON.stringify(fixture?.uiRequests ?? [], null, 2),
    );
    copyHostLog();
    await browser?.close();
  });

  test('typing at the plan answers; Change scope revises; Approve hides internal instructions and resumes once', async function () {
    await openPlan();
    const before = fixture.uiRequests.length;
    await send('@lineage What does this procedure do?');
    await page
      .getByText('Typed question received and answered.', { exact: false })
      .last()
      .waitFor({ timeout: 20000 });
    assert.ok(
      fixture.uiRequests.length > before,
      'Enter must actually reach the provider',
    );
    assert.equal(
      exports.getSession().phase.kind,
      planPhase,
      'ordinary question preserves proposal',
    );
    await idleInput();
    await changeScopeButton().click();
    await send('@lineage change scope to one level downstream');
    await idleInput();
    await waitForControl(continueButton(), 20000);
    assert.equal(
      exports.getSession().pendingExploration?.revision,
      2,
      'typed scope change revises proposal',
    );
    assert.deepEqual(
      exports.getSession().pendingExploration?.init.depthIntent,
      {
        upstream: { levels: 0, exactness: 'exact' },
        downstream: { levels: 1, exactness: 'exact' },
      },
      'one level downstream must close upstream and open one downstream level',
    );
    await approveOnce();
    await deadlineWait(
      () => exports.getSession().phase.kind === 'completed',
      'Continue must finish the trace',
    );
    await idleInput();
    assert.ok(
      exports.getSession().lastPresentResultDescription,
      'synthesis must commit an actual report',
    );
    const transcript = await page.locator('.interactive-session').innerText();
    assert.doesNotMatch(
      transcript,
      /Exploration plan confirmed|Approve exploration plan revision|lineage_confirm_exploration|Opaque request-owned/,
    );
    assert.equal(
      fixture.uiRequests
        .slice(before)
        .filter((r) =>
          r.tools.some((t) => t.name === 'lineage_submit_findings'),
        ).length,
      1,
      'one approval starts one bodied hop',
    );
  });
});
