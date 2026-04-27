/**
 * Eval-bridge LM provider — pure message router between the production
 * `@lineage` chat participant inside the vscode-tester host and an external
 * Haiku endpoint.
 *
 * @remarks
 * Registers a `vscode.lm.LanguageModelChatProvider` (vendor `eval-bridge`,
 * family `haiku`). When the production participant calls
 * `request.model.sendRequest(messages, options, token)`, VS Code routes to
 * `provideLanguageModelChatResponse` here. This provider:
 *   1. Logs the inbound `messages[]` + `options.tools[]` to a JSONL file.
 *   2. POSTs the full payload as-is to the URL set in `EVAL_BRIDGE_HAIKU_URL`.
 *   3. Reads the Haiku-side response (one or more `LanguageModelResponsePart`-shaped objects).
 *   4. Forwards each part to the participant via `progress.report(...)`.
 *   5. Logs every part in both directions.
 *
 * The bridge does NOT call Anthropic / OpenAI / any LLM. The Haiku endpoint
 * (a tiny external HTTP server the user spins up — not in this file's scope)
 * owns the actual model invocation. The bridge is transport-only: it routes
 * `messages[]` from vscode-tester to that endpoint and routes the response
 * back. NO API keys live in the extension.
 *
 * Activation: only when `EVAL_BRIDGE_HAIKU_URL` env var is set. Off by
 * default — production users never see this provider.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/log';

interface BridgeLogEntry {
  ts: string;
  direction: 'sm->bridge' | 'bridge->haiku' | 'haiku->bridge' | 'bridge->sm';
  payload: unknown;
}

/**
 * Append one entry to the bridge log file (JSONL).
 */
function logEntry(logPath: string, entry: BridgeLogEntry): void {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', { encoding: 'utf8' });
  } catch {
    // log-writing failure is non-fatal — the conversation must continue.
  }
}

/**
 * Normalise a VS Code message content array into a serialisable shape.
 */
function serialiseContent(content: ReadonlyArray<unknown>): unknown[] {
  return content.map(part => {
    if (part instanceof vscode.LanguageModelTextPart) {
      return { type: 'text', text: part.value };
    }
    if (part instanceof vscode.LanguageModelToolCallPart) {
      return { type: 'tool_use', id: part.callId, name: part.name, input: part.input };
    }
    if (part instanceof vscode.LanguageModelToolResultPart) {
      return {
        type: 'tool_result',
        tool_use_id: part.callId,
        content: (part.content || []).map((c: any) => {
          if (c instanceof vscode.LanguageModelTextPart) return { type: 'text', text: c.value };
          return c;
        }),
      };
    }
    return part;
  });
}

/**
 * Build the JSON payload that the bridge forwards to the Haiku-side endpoint.
 *
 * @remarks
 * Pure transport shape. Roles are normalised to the lowercase string the wire
 * protocol expects; `content[]` is serialised verbatim. The Haiku side owns
 * the actual model invocation — this payload is the same regardless of which
 * model it ends up calling.
 */
function buildBridgePayload(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
  modelId: string,
  toolMode: vscode.LanguageModelChatToolMode,
): any {
  return {
    model: modelId,
    toolMode,
    messages: messages.map(m => ({
      role: m.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'assistant',
      content: serialiseContent(m.content),
    })),
    tools: (tools ?? []).map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema ?? { type: 'object', properties: {} },
    })),
  };
}

/**
 * The wire-shape the Haiku side returns. One JSON object per response.
 *
 * @remarks
 * `parts` is an array of either text or tool_use entries; the bridge
 * forwards each to the participant via `progress.report(...)`. Streaming is
 * not required — the Haiku side may compose the full response and return it
 * as one chunk; the bridge will replay each part to the progress callback.
 */
interface BridgeResponse {
  parts: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
  >;
}

/**
 * Replay the Haiku-side response into the participant's progress callback.
 *
 * @remarks
 * Each entry in `parts[]` becomes one `LanguageModelTextPart` or
 * `LanguageModelToolCallPart`. This is the only translation the bridge does
 * on the response side — wire JSON → VS Code part objects.
 */
function replayResponseToProgress(
  resp: BridgeResponse,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  logPath: string,
): void {
  for (const p of resp.parts ?? []) {
    if (p.type === 'text') {
      progress.report(new vscode.LanguageModelTextPart(p.text));
      logEntry(logPath, { ts: new Date().toISOString(), direction: 'bridge->sm', payload: p });
    } else if (p.type === 'tool_use') {
      progress.report(new vscode.LanguageModelToolCallPart(p.id, p.name, p.input as object));
      logEntry(logPath, { ts: new Date().toISOString(), direction: 'bridge->sm', payload: p });
    }
  }
}

/**
 * Resolve the bridge log path.
 *
 * @remarks
 * Env-var only — no public configuration surface. Internal test-harness
 * mechanism that must NOT be discoverable to end users via settings UI.
 * Precedence: env `EVAL_BRIDGE_LOG_PATH` → fallback under
 * `test-results/eval-bridge/<timestamp>.jsonl`.
 */
function resolveLogPath(): string {
  const fromEnv = process.env.EVAL_BRIDGE_LOG_PATH;
  if (fromEnv) return fromEnv;
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(root, 'test-results', 'eval-bridge', `bridge-${ts}.jsonl`);
}

/**
 * Provider class — pure message router (SSH local-forward analogue).
 *
 * @remarks
 * Receives `messages[]` from the @lineage participant via the
 * `provideLanguageModelChatResponse` hook, POSTs them as-is to
 * `EVAL_BRIDGE_HAIKU_URL`, replays the response into the participant's
 * progress callback. The bridge does not call any LLM — it forwards bytes.
 */
class HaikuBridgeProvider implements vscode.LanguageModelChatProvider {
  constructor(
    private readonly haikuUrl: string,
    private readonly modelId: string,
    private readonly logPath: string,
    private readonly logger: Logger,
  ) {}

  provideLanguageModelChatInformation(): vscode.LanguageModelChatInformation[] {
    return [{
      id: this.modelId,
      name: `Haiku (eval bridge)`,
      family: 'haiku',
      version: this.modelId,
      maxInputTokens: 200_000,
      maxOutputTokens: 8192,
      tooltip: 'Internal test mechanism. Forwards messages to the configured Haiku endpoint.',
      detail: 'eval-bridge',
      capabilities: { toolCalling: true, imageInput: false },
    }];
  }

  async provideLanguageModelChatResponse(
    _model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const payload = buildBridgePayload(messages, options.tools, this.modelId, options.toolMode);

    // 1. Log SM→bridge: the messages[] the participant emitted.
    logEntry(this.logPath, { ts: new Date().toISOString(), direction: 'sm->bridge', payload });

    // 2. Forward to Haiku endpoint as-is.
    const controller = new AbortController();
    const cancelHandler = token.onCancellationRequested(() => controller.abort());
    let resp: BridgeResponse;
    try {
      logEntry(this.logPath, { ts: new Date().toISOString(), direction: 'bridge->haiku', payload });
      const res = await fetch(this.haikuUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '<no body>');
        const msg = `Haiku endpoint HTTP ${res.status}: ${text.slice(0, 500)}`;
        logEntry(this.logPath, { ts: new Date().toISOString(), direction: 'haiku->bridge', payload: { error: msg } });
        throw new Error(msg);
      }
      resp = (await res.json()) as BridgeResponse;
      logEntry(this.logPath, { ts: new Date().toISOString(), direction: 'haiku->bridge', payload: resp });
    } finally {
      cancelHandler.dispose();
    }

    // 3. Replay response → participant via progress.report.
    replayResponseToProgress(resp, progress, this.logPath);
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    const s = typeof text === 'string'
      ? text
      : JSON.stringify(serialiseContent(text.content));
    return Math.ceil(s.length / 4);
  }
}

/**
 * Register the bridge provider at extension activation — internal test mechanism.
 *
 * @remarks
 * Activates ONLY when env var `EVAL_BRIDGE_HAIKU_URL` is set. There is NO
 * public configuration surface — no `package.json` `contributes.configuration`
 * entry, no settings-UI toggle, no command. End users running the production
 * extension never see this provider and cannot enable it accidentally. It
 * exists exclusively for test-host invocations driven via env vars.
 *
 * No API keys live in the extension. The Haiku endpoint at the configured
 * URL is owned by the test orchestrator (a small external HTTP server that
 * actually invokes the model — Anthropic API, Claude Code Task, local
 * Ollama, whatever). The bridge is byte-forwarder.
 *
 * @returns A `Disposable` that unregisters the provider, or `null` when the
 *          env var is absent (production path).
 */
export function registerEvalBridgeLmProvider(
  outputChannel: vscode.LogOutputChannel,
): vscode.Disposable | null {
  const haikuUrl = process.env.EVAL_BRIDGE_HAIKU_URL ?? '';
  if (!haikuUrl) return null;
  const modelId = process.env.EVAL_BRIDGE_MODEL_ID ?? 'claude-haiku-4-5-20251001';
  const logPath = resolveLogPath();
  const logger = Logger.create(outputChannel, 'Bridge');
  logger.info(`Eval LM provider registered (internal test mechanism) — url=${haikuUrl}  model=${modelId}  log=${logPath}`);
  const provider = new HaikuBridgeProvider(haikuUrl, modelId, logPath, logger);
  return vscode.lm.registerLanguageModelChatProvider('eval-bridge', provider);
}
