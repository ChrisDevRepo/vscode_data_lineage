/**
 * LM traffic tracer — built-in observability tool for diagnosing AI session behavior.
 *
 * @internal
 * @remarks
 * Development observability tool — not part of the extension's public API and never
 * active in release builds (ENABLED defaults to false).
 *
 * Captures the full traffic of every `vscode.lm.sendRequest` call as NDJSON to
 * `tmp/lm-trace/trace-{iso}.ndjson` for post-session diagnostic analysis:
 * token spend per phase, tool call patterns, context wipes, rejections, and
 * response quality metrics.
 *
 * Lifecycle:
 * - `ENABLED = true`  → trace file is created on {@link LmTracer.init}, all events written.
 * - `ENABLED = false` → every method is a no-op; no file is created (default for releases).
 *
 * Analyse a captured trace:
 * ```
 * node tests/tools/trace-analyze.js tmp/lm-trace/<file>.ndjson --summary
 * ```
 *
 * Full reference: the **LM traffic tracer** section in `docs/DEVELOPER_GUIDE.md`.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// DEV TRACE — set true to capture LM traffic to tmp/lm-trace/ for diagnostic analysis.
// Default is false for release builds. Flip to true only during active diagnosis.
// See docs/LM_TRACING.md for the full analysis workflow.
const ENABLED = true; // ← flip to false to disable

/** JSON-safe snapshot of one content part from a serialized LM message; written to the trace file only. */
interface TracePart {
  type: 'text' | 'tool_call' | 'tool_result' | 'unknown';
  value?: string;
  name?: string;
  callId?: string;
  input?: unknown;
  content?: string[];
}

/** Serialized form of a `vscode.LanguageModelChatMessage` as recorded in the NDJSON trace. */
interface TraceMessage {
  role: 'user' | 'assistant';
  parts: TracePart[];
}

export class LmTracer {
  static readonly enabled: boolean = ENABLED;
  private static filePath: string | null = null;

  /**
   * Opens the trace file. Call once from `extension.ts` activate.
   * @param workspaceRoot - absolute path to the workspace root
   */
  static init(workspaceRoot: string): void {
    if (!ENABLED) return;
    const dir = path.join(workspaceRoot, 'tmp', 'lm-trace');
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // If the directory can't be created, all writes will silently no-op.
      return;
    }
    const iso = new Date().toISOString().replace(/[:.]/g, '-');
    this.filePath = path.join(dir, `trace-${iso}.ndjson`);
  }

  /** Serializes a VS Code LM message array to a plain JSON-safe structure. */
  static serializeMessages(messages: vscode.LanguageModelChatMessage[]): TraceMessage[] {
    return messages.map(msg => {
      const role: 'user' | 'assistant' =
        msg.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'assistant';
      const parts: TracePart[] = [];
      const content = msg.content as unknown;
      if (typeof content === 'string') {
        parts.push({ type: 'text', value: content });
      } else if (Array.isArray(content)) {
        for (const p of content) {
          if (p instanceof vscode.LanguageModelTextPart) {
            parts.push({ type: 'text', value: p.value });
          } else if (p instanceof vscode.LanguageModelToolCallPart) {
            parts.push({ type: 'tool_call', name: p.name, callId: p.callId, input: p.input });
          } else if (p instanceof vscode.LanguageModelToolResultPart) {
            const strs: string[] = [];
            for (const c of (p.content as unknown[])) {
              if (c instanceof vscode.LanguageModelTextPart) strs.push(c.value);
            }
            parts.push({ type: 'tool_result', callId: p.callId, content: strs });
          } else {
            parts.push({ type: 'unknown' });
          }
        }
      }
      return { role, parts };
    });
  }

  // ── write ─────────────────────────────────────────────────────────────────

  private static write(ev: string, sid: string, rid: number, extra: Record<string, unknown>): void {
    if (!ENABLED || !this.filePath) return;
    const line = JSON.stringify({ _: 'TX', ev, sid, rid, t: Date.now(), ...extra });
    try {
      fs.appendFileSync(this.filePath, line + '\n', 'utf8');
    } catch { /* silently ignore write errors in dev */ }
  }

  // ── public API ─────────────────────────────────────────────────────────────

  /** Emitted once per turn at entry to handleChatRequest. */
  static sessionStart(sid: string, modelId: string, maxTokens: number): void {
    if (!ENABLED) return;
    this.write('SESSION_START', sid, 0, { modelId, maxTokens });
  }

  /** Emitted immediately before every vscode.lm.sendRequest call. */
  static request(
    sid: string,
    rid: number,
    phase: string,
    messages: vscode.LanguageModelChatMessage[],
    tools: string[],
    mode: string,
  ): void {
    if (!ENABLED) return;
    this.write('REQ', sid, rid, {
      phase,
      tools,
      mode,
      msgCount: messages.length,
      messages: this.serializeMessages(messages),
    });
  }

  /** Emitted for each LanguageModelToolCallPart that arrives in the response stream. */
  static toolCall(sid: string, rid: number, tool: string, callId: string, input: Record<string, unknown>): void {
    if (!ENABLED) return;
    this.write('TOOL_CALL', sid, rid, { tool, callId, input });
  }

  /** Emitted immediately before vscode.lm.invokeTool. cached=true for dedup-cache hits. */
  static toolInvoke(sid: string, rid: number, tool: string, callId: string, cached: boolean): void {
    if (!ENABLED) return;
    this.write('TOOL_INVOKE', sid, rid, { tool, callId, cached });
  }

  /** Emitted after vscode.lm.invokeTool returns, with full result content + any error/hint. */
  static toolResult(
    sid: string,
    rid: number,
    tool: string,
    callId: string,
    result: vscode.LanguageModelToolResult,
    ms: number,
  ): void {
    if (!ENABLED) return;
    const content: string[] = [];
    let errCode: string | null = null;
    let hint: string | null = null;
    for (const p of result.content) {
      if (!(p instanceof vscode.LanguageModelTextPart)) continue;
      content.push(p.value);
      try {
        const parsed = JSON.parse(p.value) as Record<string, unknown>;
        if (parsed?.error) errCode = String(parsed.error);
        if (parsed?.hint) hint = String(parsed.hint);
      } catch { /* not JSON — fine */ }
    }
    const extra: Record<string, unknown> = { tool, callId, ms, result: content };
    if (errCode) extra.errCode = errCode;
    if (hint) extra.hint = hint;
    this.write('TOOL_RESULT', sid, rid, extra);
  }

  /** Emitted after each round (stream drained + tool results collected). */
  static round(
    sid: string,
    rid: number,
    phase: string,
    ms: number,
    inTok: number,
    outTok: number,
    toolCount: number,
  ): void {
    if (!ENABLED) return;
    this.write('ROUND', sid, rid, { phase, ms, inTok, outTok, toolCount });
  }

  /** Emitted before every envelope.wipeAndSeed call. msgsBefore = envelope.length before wipe. */
  static wipe(sid: string, rid: number, trigger: string, msgsBefore: number): void {
    if (!ENABLED) return;
    this.write('WIPE', sid, rid, { trigger, msgsBefore });
  }

  /**
   * Emitted once for the final text response of a session — the round that returns
   * no tool calls and exits `final_answer`. This is the only round whose text never
   * appears in a subsequent REQ message history, so it must be captured explicitly.
   */
  static finalAnswer(sid: string, rid: number, text: string): void {
    if (!ENABLED) return;
    this.write('ANSWER_TEXT', sid, rid, { chars: text.length, text });
  }

  /** Emitted once after runHopLoop returns, before dispatchExit. */
  static sessionEnd(
    sid: string,
    cumInTok: number,
    cumOutTok: number,
    peakTok: number,
    rounds: number,
    tools: number,
    exitKind: string,
  ): void {
    if (!ENABLED) return;
    this.write('SESSION_END', sid, 0, { cumInTok, cumOutTok, peakTok, rounds, tools, exitKind });
  }

  /** Call from extension deactivate — appendFileSync is sync so nothing to flush. */
  static flush(): void {
    // intentional no-op — appendFileSync writes are synchronous
  }
}
