import * as assert from 'assert';
import * as vscode from 'vscode';
import { getApi, waitFor, sleep } from './helpers/edhUtils';

// L2 — diagnostic + scaffolding commands, verified programmatically.
// Covers: copyDebugInfo (clipboard), dumpSmState (no-SM guard), createParseRules (scaffold).
suite('Diagnostic & scaffolding commands', () => {

  // ── 1. copyDebugInfo ──────────────────────────────────────────────────────
  suite('dataLineageViz.copyDebugInfo', () => {
    test('writes debug dump to clipboard after demo load, dump contains expected sections', async function () {
      this.timeout(60000);
      const api = await getApi();
      await vscode.commands.executeCommand('dataLineageViz.openDemo');

      const model = await waitFor(() => api.getSession().model, 45000);
      const nodeCount = model.nodes.length;
      assert.ok(nodeCount > 0, `model must have nodes before copy-debug (got ${nodeCount})`);

      await vscode.commands.executeCommand('dataLineageViz.copyDebugInfo');

      // Poll clipboard until non-empty (the command is async — clipboard write may
      // complete slightly after the awaited executeCommand returns on some hosts).
      let dump = '';
      const deadline = Date.now() + 5000;
      while (!dump && Date.now() < deadline) {
        dump = await vscode.env.clipboard.readText();
        if (!dump) await sleep(200);
      }
      assert.ok(dump.length > 0, 'clipboard must be non-empty after copyDebugInfo');

      // ── section headers present (verbatim from buildDebugDump in messageHandlers.ts) ──
      assert.ok(dump.includes('ENVIRONMENT'),           'dump must contain "ENVIRONMENT" section');
      assert.ok(dump.includes('DATA SOURCE'),           'dump must contain "DATA SOURCE" section');
      assert.ok(dump.includes('MODEL'),                 'dump must contain "MODEL" section');
      assert.ok(dump.includes('Nodes total:'),          'dump must contain "Nodes total:" line');
      assert.ok(dump.includes('RENDER STATE'),          'dump must contain "RENDER STATE" section');
      assert.ok(dump.includes('SM SUMMARY'),            'dump must contain "SM SUMMARY" section');
      assert.ok(dump.includes('LAST ERRORS'),           'dump must contain "LAST ERRORS" section');
      assert.ok(dump.includes('SETTINGS'),              'dump must contain "SETTINGS" section');

      // ── node count in dump matches live model ──
      // Line format: "  Nodes total:  <N>"
      const nodeLineMatch = dump.match(/Nodes total:\s+(\d+)/);
      assert.ok(nodeLineMatch, 'dump must contain a parseable "Nodes total:" count');
      const dumpedCount = parseInt(nodeLineMatch![1], 10);
      assert.strictEqual(
        dumpedCount,
        nodeCount,
        `node count in dump (${dumpedCount}) must match session model (${nodeCount})`,
      );
    });
  });

  // ── 2. dumpSmState ────────────────────────────────────────────────────────
  suite('dataLineageViz.dumpSmState', () => {
    test('resolves without throwing when no SM is active', async function () {
      this.timeout(15000);
      // Extension must be active; model presence is not required for this path.
      await getApi();

      // The command early-returns with a notifyWarning when sess.stateMachine is null.
      // It must never throw — the awaited call itself is the assertion.
      let threw = false;
      try {
        await vscode.commands.executeCommand('dataLineageViz.dumpSmState');
      } catch {
        threw = true;
      }
      assert.strictEqual(threw, false, 'dumpSmState must not throw when no SM is active');
    });

    test('no-SM guard emits a warning log line', async function () {
      this.timeout(15000);
      const api = await getApi();
      const logsBefore = api.testLogCapture.length;

      await vscode.commands.executeCommand('dataLineageViz.dumpSmState');

      // Give the synchronous notifyWarning a tick to flush into the capture buffer.
      await sleep(100);

      const newLines = api.testLogCapture.slice(logsBefore).join('\n');
      // notifyWarning routes through Logger → outputChannel → testLogCapture.
      // The warning message is "Data Lineage: No active state machine to dump."
      assert.ok(
        /No active state machine/i.test(newLines),
        `expected "No active state machine" warning in captured logs after dumpSmState with no SM.\nNew log lines:\n${newLines}`,
      );
    });
  });

  // ── 3. createParseRules (scaffolding) ────────────────────────────────────
  suite('dataLineageViz.createParseRules', () => {
    test('executes without throwing (creates or opens parseRules.yaml)', async function () {
      this.timeout(15000);
      await getApi();

      let threw = false;
      try {
        await vscode.commands.executeCommand('dataLineageViz.createParseRules');
      } catch {
        threw = true;
      }
      assert.strictEqual(threw, false, 'createParseRules must not throw');
    });
  });
});
