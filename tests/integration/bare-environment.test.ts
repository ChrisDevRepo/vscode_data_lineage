import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { announceLaneTier } from './laneTier';

/**
 * Proves the extension survives a host with NO optional integrations present.
 *
 * @remarks
 * Owner rule — "the extension must never crash": the core
 * product is `.dacpac` → lineage graph and must keep working with no GitHub Copilot, no chat/LM
 * provider, and no `ms-mssql.mssql`. Crashing is worse than any missing feature, and a throw
 * escaping `activate()` loses every command, view and provider the extension would have
 * registered — so a user who never touches AI would lose the graph because of a feature they do
 * not use.
 *
 * That rule carries a proof obligation: the absent case must be *demonstrated*, not argued. This
 * lane is that demonstration. It launches with `--disable-extensions` and — unlike the `scripted-provider`
 * and `participant` lanes — deliberately supplies **no** `--extensionDevelopmentPath` for the
 * language-model provider fixture, so the host genuinely has no chat model, no Copilot and no
 * mssql. The first two assertions verify that emptiness rather than assuming it, because an
 * assertion that the extension works "without Copilot" is worthless if Copilot was quietly present.
 * The lane label's own comment in `.vscode-test.mjs` records why no fixture may be added here.
 *
 * What this can and cannot cover: it proves activation completes and the core surface is live in a
 * bare host. It does not simulate `vscode.chat` being absent outright (a VS Code fork, or chat
 * disabled by enterprise policy) — that is not reachable from inside a real VS Code host, and the
 * containment for it is the `try/catch` around the AI block in `src/extension.ts`.
 */
suite('Bare environment — no Copilot, no chat model, no mssql', () => {
  const EXTENSION_ID = 'datahelper-chwagner.data-lineage-viz';

  suiteSetup(() => announceLaneTier(
    'bare-environment',
    'none',
    'activation completes and the core command surface registers with every optional integration absent',
  ));

  test('the host really is bare — no optional integration is installed', () => {
    assert.strictEqual(
      vscode.extensions.getExtension('ms-mssql.mssql'),
      undefined,
      'this lane must run without the mssql extension, or it proves nothing about its absence',
    );
    for (const id of ['github.copilot', 'github.copilot-chat']) {
      assert.strictEqual(
        vscode.extensions.getExtension(id),
        undefined,
        `this lane must run without ${id}, or it proves nothing about its absence`,
      );
    }
  });

  test('no chat model is available, and asking for one does not throw', async () => {
    const models = await vscode.lm.selectChatModels();
    assert.strictEqual(
      models.length,
      0,
      'a bare host must expose zero chat models; a non-empty result means a provider leaked in',
    );
  });

  test('activation completes and reports no error', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, 'extension must be present in the Extension Development Host');

    // The assertion that matters: `activate()` resolves rather than rejecting. Were the optional
    // AI surface able to fail activation, this is where it would surface.
    await extension.activate();
    assert.strictEqual(extension.isActive, true, 'extension must be active in a bare host');
  });

  test('the CORE product is fully registered despite every integration being absent', async () => {
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
    const commands = await vscode.commands.getCommands(true);

    // Core lineage commands — these are the product, and none of them depends on AI or a database.
    // `openDemo` is the strongest of these: it loads a bundled `.dacpac` and renders the graph
    // with no external dependency of any kind, which is exactly the journey that must survive.
    for (const command of [
      'dataLineageViz.open',
      'dataLineageViz.openDemo',
      'dataLineageViz.refresh',
      'dataLineageViz.createParseRules',
      'dataLineageViz.createDmvQueries',
    ]) {
      assert.ok(
        commands.includes(command),
        `core command ${command} must be registered in a bare host`,
      );
    }
  });

  test('the AI surface degrades without taking the extension down', async () => {
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
    const commands = await vscode.commands.getCommands(true);

    assert.ok(
      commands.includes('dataLineageViz.enableAiTraceLogging'),
      'the session-scoped AI trace command must be registered without a model provider',
    );

    // `dataLineageViz.ai.enabled` defaults to true, so the AI surface DOES register here — the
    // point is that registering it against a host with no model provider is survivable. If the
    // registration had thrown, the previous test's `activate()` would have rejected and the core
    // commands above would be missing.
    assert.ok(
      commands.includes('dataLineageViz.aiResumeNativeGate'),
      'the participant registers even with no chat model present',
    );
  });
});
