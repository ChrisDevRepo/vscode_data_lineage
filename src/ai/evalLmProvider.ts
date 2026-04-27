/**
 * Eval-bridge LM provider — pure message router between the production
 * `@lineage` chat participant and Anthropic Haiku.
 *
 * @remarks
 * Registers a `vscode.lm.LanguageModelChatProvider` (vendor `eval-bridge`,
 * family `haiku`). When the production participant calls
 * `request.model.sendRequest(messages, options, token)`, VS Code routes to
 * `provideLanguageModelChatResponse` here. This provider:
 *   1. Logs the inbound `messages[]` + `options.tools[]` to a JSONL file
 *      (every message that crosses the bridge — full fidelity).
 *   2. Translates VS Code message format to Anthropic Messages API format.
 *   3. Calls Anthropic with streaming enabled.
 *   4. Translates streamed Anthropic deltas to `LanguageModelResponsePart`s
 *      and forwards them to the participant via the `progress` callback.
 *   5. Logs the outbound response parts.
 *
 * NO message rebuilding. NO bridge-side decision-making. The participant
 * builds messages exactly as production; this provider relays them.
 *
 * Activation: only when `EVAL_BRIDGE_ANTHROPIC_KEY` env var is set OR the
 * `dataLineageViz.eval.lmProviderEnabled` setting is true. Off by default —
 * production users never see this provider.
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
 * Translate VS Code messages → Anthropic Messages API request body.
 *
 * @remarks
 * VS Code message roles are User / Assistant. Anthropic API uses `user` and
 * `assistant` plus a top-level `system` field. We extract the first User
 * message (the participant's system prompt envelope) into the Anthropic
 * `system` field; subsequent messages flow as a normal alternating
 * conversation.
 */
function buildAnthropicRequest(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
  modelId: string,
): { url: string; body: any } {
  // Per `code-quality.md` "User-as-System invariant" the participant emits
  // msg[0] as a User message containing the system prompt. Anthropic API
  // wants this hoisted into the top-level `system` field for proper caching.
  let systemText = '';
  const conversation: any[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const parts = serialiseContent(m.content);
    const role = m.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'assistant';
    if (i === 0 && role === 'user') {
      systemText = parts.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('\n\n');
      continue;
    }
    conversation.push({ role, content: parts });
  }

  const body: any = {
    model: modelId,
    max_tokens: 8192,
    stream: true,
    messages: conversation,
  };
  if (systemText) body.system = systemText;
  if (tools && tools.length > 0) {
    body.tools = tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema ?? { type: 'object', properties: {} },
    }));
  }
  return { url: 'https://api.anthropic.com/v1/messages', body };
}

/**
 * Stream Anthropic SSE response → VS Code progress callback.
 *
 * @remarks
 * Anthropic streams `event:` lines with JSON `data:` payloads. We translate
 * `content_block_delta` (text + input_json) and `content_block_start`
 * (tool_use start) events into `LanguageModelTextPart` /
 * `LanguageModelToolCallPart` and forward via `progress.report`.
 */
async function streamAnthropicToProgress(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  logPath: string,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  // Per-tool-block accumulator (Anthropic streams tool input as JSON deltas).
  const toolBlocks: Map<number, { id: string; name: string; jsonAccum: string }> = new Map();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let evt: any;
      try { evt = JSON.parse(payload); } catch { continue; }

      logEntry(logPath, { ts: new Date().toISOString(), direction: 'haiku->bridge', payload: evt });

      if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
        toolBlocks.set(evt.index, { id: evt.content_block.id, name: evt.content_block.name, jsonAccum: '' });
      } else if (evt.type === 'content_block_delta') {
        const d = evt.delta;
        if (d?.type === 'text_delta' && d.text) {
          const part = new vscode.LanguageModelTextPart(d.text);
          progress.report(part);
          logEntry(logPath, { ts: new Date().toISOString(), direction: 'bridge->sm', payload: { type: 'text', text: d.text } });
        } else if (d?.type === 'input_json_delta') {
          const blk = toolBlocks.get(evt.index);
          if (blk) blk.jsonAccum += d.partial_json || '';
        }
      } else if (evt.type === 'content_block_stop') {
        const blk = toolBlocks.get(evt.index);
        if (blk) {
          let input: any = {};
          try { input = blk.jsonAccum ? JSON.parse(blk.jsonAccum) : {}; } catch { input = { _raw: blk.jsonAccum }; }
          const part = new vscode.LanguageModelToolCallPart(blk.id, blk.name, input);
          progress.report(part);
          logEntry(logPath, { ts: new Date().toISOString(), direction: 'bridge->sm', payload: { type: 'tool_use', id: blk.id, name: blk.name, input } });
          toolBlocks.delete(evt.index);
        }
      }
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
 * Provider class — message-only router.
 */
class HaikuBridgeProvider implements vscode.LanguageModelChatProvider {
  constructor(
    private readonly apiKey: string,
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
      tooltip: 'Routes @lineage messages to Anthropic Haiku via the eval bridge. Logs every message that crosses the bridge.',
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
    // 1. Log inbound — every SM-→bridge message.
    logEntry(this.logPath, {
      ts: new Date().toISOString(),
      direction: 'sm->bridge',
      payload: {
        message_count: messages.length,
        messages: messages.map(m => ({
          role: m.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'assistant',
          content: serialiseContent(m.content),
        })),
        tool_count: options.tools?.length ?? 0,
        tools: (options.tools ?? []).map(t => ({ name: t.name, description: t.description })),
        toolMode: options.toolMode,
      },
    });

    // 2. Translate to Anthropic shape.
    const { url, body } = buildAnthropicRequest(messages, options.tools, this.modelId);
    logEntry(this.logPath, { ts: new Date().toISOString(), direction: 'bridge->haiku', payload: body });

    // 3. POST to Anthropic with streaming.
    const controller = new AbortController();
    const cancelHandler = token.onCancellationRequested(() => controller.abort());
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '<no body>');
        const msg = `Anthropic HTTP ${res.status}: ${text.slice(0, 500)}`;
        logEntry(this.logPath, { ts: new Date().toISOString(), direction: 'haiku->bridge', payload: { error: msg } });
        throw new Error(msg);
      }
      if (!res.body) throw new Error('Anthropic response had no body');
      const reader = res.body.getReader();
      await streamAnthropicToProgress(reader, progress, this.logPath);
    } finally {
      cancelHandler.dispose();
    }
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
 * Activates ONLY when env var `EVAL_BRIDGE_ANTHROPIC_KEY` (or `ANTHROPIC_API_KEY`)
 * is set. There is NO public configuration surface — no `package.json`
 * `contributes.configuration` entry, no settings-UI toggle, no command. End
 * users running the production extension never see this provider, never see
 * any reference to it in settings, and cannot enable it accidentally. It
 * exists exclusively for test-host invocations driven via env vars
 * (typically `tests/e2e/...` setup).
 *
 * @returns A `Disposable` that unregisters the provider, or `null` when the
 *          env var is absent (production path).
 */
export function registerEvalBridgeLmProvider(
  outputChannel: vscode.LogOutputChannel,
): vscode.Disposable | null {
  const apiKey = process.env.EVAL_BRIDGE_ANTHROPIC_KEY ?? process.env.ANTHROPIC_API_KEY ?? '';
  if (!apiKey) return null;
  const modelId = process.env.EVAL_BRIDGE_MODEL_ID ?? 'claude-haiku-4-5-20251001';
  const logPath = resolveLogPath();
  const logger = Logger.create(outputChannel, 'Bridge');
  logger.info(`Eval LM provider registered (internal test mechanism) — model=${modelId}  log=${logPath}`);
  const provider = new HaikuBridgeProvider(apiKey, modelId, logPath, logger);
  return vscode.lm.registerLanguageModelChatProvider('eval-bridge', provider);
}
