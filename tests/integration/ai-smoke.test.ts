/** Exercises one real provider-backed @lineage turn through VS Code's public model API. */
import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { copyNativeHostLog } from '../harness/nativeEvidence';
import {
  activateHost,
  chatRequest,
  openDemo,
  recordingStream,
} from './hostSession';

suite('Real provider smoke', () => {
  const TEST_TIMEOUT_MS = Number(process.env.AI_TEST_TIMEOUT_MS);
  const DEADLINE_MARGIN_MS = 10_000;

  test('a configured provider completes a public demo-data question', async function () {
    this.timeout(TEST_TIMEOUT_MS + 60_000);
    const startedAt = Date.now();
    const testDeadline = startedAt + TEST_TIMEOUT_MS;
    for (const name of [
      'AI_TEST_PROVIDER',
      'AI_TEST_ENDPOINT',
      'AI_TEST_API_KEY',
      'AI_TEST_MODEL',
    ]) {
      assert.ok(
        process.env[name],
        `Set ${name} in .env before running npm run test:ai:smoke.`,
      );
    }

    const { model, exports, extensionPath } = await activateHost();
    const directory = join(
      extensionPath,
      'test-results',
      'ai-smoke',
      randomUUID(),
    );
    mkdirSync(directory, { recursive: true });
    const tracePath = await vscode.commands.executeCommand<string>(
      'dataLineageViz.enableAiTraceLogging',
      true,
    );
    assert.ok(tracePath, 'real-provider smoke requires a fresh verbose trace');
    await openDemo(
      Math.min(testDeadline - DEADLINE_MARGIN_MS - Date.now(), 45_000),
    );

    const { stream, markdown: answer } = recordingStream();
    const cancellation = new vscode.CancellationTokenSource();
    // Cancellation aborts the provider request; reserve only teardown time.
    const cancelAt = testDeadline - DEADLINE_MARGIN_MS;
    assert.ok(
      cancelAt > Date.now(),
      'setup left no safe time for a provider turn',
    );
    const cancelTimer = setTimeout(
      () => cancellation.cancel(),
      cancelAt - Date.now(),
    );
    let finalStatus = 'error';
    let modelCalls = 0;
    const question =
      'Which tables feed Sales? Name the sources you can verify from the loaded lineage data.';
    try {
      const result = await exports.participant.handleChatRequest(
        chatRequest(question, model),
        { history: [] },
        stream,
        cancellation.token,
      );
      const metadata = (result as vscode.ChatResult)?.metadata as
        | { status?: string; modelCalls?: number }
        | undefined;
      finalStatus = metadata?.status ?? 'missing';
      modelCalls = metadata?.modelCalls ?? 0;
      assert.strictEqual(
        metadata?.status,
        'ok',
        'the real-provider turn must settle successfully',
      );
      assert.ok(
        modelCalls > 0,
        'the participant must call the configured provider',
      );
      assert.ok(
        answer().trim().length > 0,
        'the participant must produce an answer',
      );
    } finally {
      clearTimeout(cancelTimer);
      cancellation.dispose();
      let trace = '';
      const drainBy = Date.now() + 2000;
      do {
        trace = existsSync(tracePath) ? readFileSync(tracePath, 'utf8') : '';
        if (trace.includes('"type":"turn-terminal"')) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      } while (Date.now() < drainBy);
      writeFileSync(join(directory, 'trace.ndjson'), trace);
      copyNativeHostLog(process.env.DLV_AI_SMOKE_PROFILE, directory);
      writeFileSync(join(directory, 'answer.txt'), answer());
      console.log(
        `[ai-smoke] provider=${process.env.AI_TEST_PROVIDER} model=${process.env.AI_TEST_MODEL} ` +
          `adapter=${model.vendor}/${model.family}/${model.version} elapsedMs=${Date.now() - startedAt} ` +
          `status=${finalStatus} modelCalls=${modelCalls}`,
      );
    }
  });
});
