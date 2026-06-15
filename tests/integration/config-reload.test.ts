import * as assert from 'assert';
import * as vscode from 'vscode';
import { getApi, waitFor, sleep } from './helpers/edhUtils';

// L2 — configuration-change handling. Verifies the three branches in the
// onDidChangeConfiguration handler (extension.ts) and the no-panel guard in
// the refresh command (commands.ts).
suite('Configuration-change handling', () => {
  /**
   * Polls `testLogCapture` until a line containing `substring` appears, or
   * `timeoutMs` elapses.
   */
  async function waitForLog(
    capture: string[],
    substring: string,
    timeoutMs = 10000,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = capture.find((l) => l.includes(substring));
      if (hit) return hit;
      await sleep(100);
    }
    throw new Error(
      `waitForLog: "${substring}" not found within ${timeoutMs}ms.\n` +
        `Captured lines (last 20):\n${capture.slice(-20).join('\n')}`,
    );
  }

  // ---------------------------------------------------------------------------
  // TC-1  DISPLAY key → pushed rebuild-config (panel must be open)
  // ---------------------------------------------------------------------------
  suite('TC-1: DISPLAY key triggers rebuild-config push', () => {
    const SETTING_KEY = 'layout.direction';
    const FULL_KEY = `dataLineageViz.${SETTING_KEY}`;
    let originalValue: string | undefined;

    suiteSetup(async function () {
      this.timeout(60000);
      // Open the demo panel and wait for the model to load.
      const api = await getApi();
      await vscode.commands.executeCommand('dataLineageViz.openDemo');
      await waitFor(() => api.getSession().model, 45000);

      // Capture the current value so we can restore it.
      originalValue = vscode.workspace
        .getConfiguration('dataLineageViz')
        .get<string>(SETTING_KEY);
    });

    suiteTeardown(async () => {
      // Restore the setting regardless of test outcome.
      await vscode.workspace
        .getConfiguration('dataLineageViz')
        .update(SETTING_KEY, originalValue, vscode.ConfigurationTarget.Global);
    });

    test('changing layout.direction emits the display-settings rebuild-config debug line', async function () {
      this.timeout(20000);
      const api = await getApi();

      // Snapshot current log length so we only look at new lines.
      const before = api.testLogCapture.length;

      // Flip to the opposite value — default is 'LR', so flip to 'TB'.
      const newValue = originalValue === 'LR' ? 'TB' : 'LR';
      await vscode.workspace
        .getConfiguration('dataLineageViz')
        .update(SETTING_KEY, newValue, vscode.ConfigurationTarget.Global);

      // Expected line (extension.ts L147):
      //   configLogger.debug('Display settings changed — pushed rebuild-config to panel')
      // Captured as: '[Config] Display settings changed — pushed rebuild-config to panel'
      const EXPECTED = 'Display settings changed — pushed rebuild-config to panel';
      const capture = api.testLogCapture;

      // Poll only the newly appended portion of the log buffer.
      const deadline = Date.now() + 10000;
      let found: string | undefined;
      while (Date.now() < deadline) {
        found = capture.slice(before).find((l) => l.includes(EXPECTED));
        if (found) break;
        await sleep(100);
      }

      assert.ok(
        found,
        `Expected a [Config] line containing "${EXPECTED}" after changing ${FULL_KEY}.\n` +
          `New log lines:\n${capture.slice(before).join('\n')}`,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // TC-2  RELOAD key → notification log line (NOT the display rebuild line)
  // ---------------------------------------------------------------------------
  suite('TC-2: RELOAD key triggers notification log, not display rebuild', () => {
    const SETTING_KEY = 'maxNodes';
    let originalValue: number | undefined;

    suiteSetup(async () => {
      originalValue = vscode.workspace
        .getConfiguration('dataLineageViz')
        .get<number>(SETTING_KEY);
    });

    suiteTeardown(async () => {
      await vscode.workspace
        .getConfiguration('dataLineageViz')
        .update(SETTING_KEY, originalValue, vscode.ConfigurationTarget.Global);
    });

    test('changing maxNodes emits the RELOAD notification info line', async function () {
      this.timeout(20000);
      const api = await getApi();
      const before = api.testLogCapture.length;

      // Use a valid in-range value that differs from the default (2000 → 1800).
      const newValue = (originalValue ?? 2000) === 2000 ? 1800 : 2000;
      await vscode.workspace
        .getConfiguration('dataLineageViz')
        .update(SETTING_KEY, newValue, vscode.ConfigurationTarget.Global);

      // Expected line (extension.ts L135-136):
      //   configLogger.info(`Config changed — notification="${msg}"`)
      //   where msg = 'Max nodes changed. Reload your data source to apply.'
      // Captured as: '[Config] Config changed — notification="Max nodes changed. Reload your data source to apply."'
      const EXPECTED_RELOAD = 'Config changed — notification="Max nodes changed. Reload your data source to apply."';
      const DISPLAY_REBUILD = 'Display settings changed — pushed rebuild-config to panel';

      const capture = api.testLogCapture;
      const deadline = Date.now() + 10000;
      let found: string | undefined;
      while (Date.now() < deadline) {
        found = capture.slice(before).find((l) => l.includes(EXPECTED_RELOAD));
        if (found) break;
        await sleep(100);
      }

      assert.ok(
        found,
        `Expected a [Config] line containing "${EXPECTED_RELOAD}" after changing dataLineageViz.${SETTING_KEY}.\n` +
          `New log lines:\n${capture.slice(before).join('\n')}`,
      );

      // The DISPLAY rebuild must NOT have been posted for a RELOAD key — that
      // branch is guarded by DISPLAY_KEYS.some(...) which excludes maxNodes.
      const wrongLine = capture.slice(before).find((l) => l.includes(DISPLAY_REBUILD));
      assert.ok(
        !wrongLine,
        `RELOAD key change must NOT emit the display rebuild line, but found: "${wrongLine}"`,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // TC-3  dataLineageViz.refresh with NO panel → notifyInfo guard
  // ---------------------------------------------------------------------------
  suite('TC-3: refresh command with no panel logs the no-panel guard', () => {
    test('dataLineageViz.refresh without a panel logs the open-a-view info line', async function () {
      this.timeout(20000);
      const api = await getApi();

      // Close any open panel so getActivePanel() returns undefined.
      const panel = api.getActivePanel();
      if (panel) {
        panel.dispose();
        // Give VS Code a tick to process the disposal.
        await sleep(300);
      }

      // Confirm no panel is active before running the command.
      assert.strictEqual(
        api.getActivePanel(),
        undefined,
        'Expected no active panel before running refresh',
      );

      const before = api.testLogCapture.length;
      await vscode.commands.executeCommand('dataLineageViz.refresh');

      // Expected line (commands.ts L82):
      //   notifyInfo(configLogger, 'Refresh', 'Open a Data Lineage view first.', { command: 'dataLineageViz.refresh' })
      // notifyInfo formats as:
      //   logger.info(`${operation} — notification="${userMessage}"${formatContext(context)}`)
      // → '[Config] Refresh — notification="Open a Data Lineage view first." — command=dataLineageViz.refresh'
      const EXPECTED = 'Refresh — notification="Open a Data Lineage view first." — command=dataLineageViz.refresh';
      const capture = api.testLogCapture;

      const deadline = Date.now() + 5000;
      let found: string | undefined;
      while (Date.now() < deadline) {
        found = capture.slice(before).find((l) => l.includes(EXPECTED));
        if (found) break;
        await sleep(100);
      }

      assert.ok(
        found,
        `Expected a [Config] line containing "${EXPECTED}" when refresh is called without a panel.\n` +
          `New log lines:\n${capture.slice(before).join('\n')}`,
      );
    });
  });
});
