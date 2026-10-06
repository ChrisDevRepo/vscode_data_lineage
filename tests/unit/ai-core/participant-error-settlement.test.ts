import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
vi.mock('vscode', async original => ({ ...await original<object>(), l10n: { t: (text: string) => text }, workspace: { getConfiguration: () => ({ get: () => undefined }) }, StatusBarAlignment: { Left: 1 }, window: { createStatusBarItem: () => ({ show() {}, hide() {} }) } }));
import { LineageParticipant } from '../../../src/ai/participant/lineageParticipant';
import { AiSession } from '../../../src/ai/session/session';
import { LineageRuntime } from '../../../src/ai/runtime/lineageRuntime';
import { buildAiToolRegistry } from '../../../src/ai/tools/toolProvider';
import type { AiTraceRecord, AiTraceWriter } from '../../../src/ai/observability/aiTraceWriter';
import { makeModel, makeNode } from '../sm/helpers/fixtures';

const BADGE = 'What could I explore next?';
/** Provider text that echoes prompt content, as some providers do in their error messages. */
const PROVIDER_ECHO = 'request rejected near refund ledger reconciliation clause';

const PRIOR_TURN = [
  { prompt: 'How do refunds affect net revenue?', command: undefined, references: [], participant: 'dataLineageViz.lineage', toolReferences: [] },
  { response: [{ value: { value: 'Refunds reduce net revenue.' } }], result: { metadata: { status: 'ok' } }, participant: 'dataLineageViz.lineage' },
] as unknown as vscode.ChatContext['history'];

function fixture() {
  const session = new AiSession();
  session.model = makeModel(['Origin', 'Related'].map(name => makeNode({ id: `[dbo].[${name}]`, schema: 'dbo', name, type: 'table' })), [['[dbo].[Related]', '[dbo].[Origin]']], ['dbo']);
  session.phase = { kind: 'completed' };
  session.memory.setUserQuestion('How do refunds affect net revenue?');
  session.resultGraph = { nodeIds: ['[dbo].[Origin]'], edges: [], source: 'test', originNodeId: '[dbo].[Origin]' };
  session.stateMachine = { deferredQuestions: [] } as unknown as NonNullable<AiSession['stateMachine']>;
  const lines = { error: [] as string[], debug: [] as string[] };
  const channel = { info() {}, warn() {}, trace() {}, debug: (line: string) => lines.debug.push(line), error: (line: string) => lines.error.push(line) } as unknown as vscode.LogOutputChannel;
  const records: AiTraceRecord[] = [];
  const traceWriter = { write: vi.fn(async (record: AiTraceRecord) => { records.push(record); }), writeTurnEvent: vi.fn(async () => {}), isEnabled: () => false, isVerbose: () => false } as unknown as AiTraceWriter;
  const runtime = new LineageRuntime({ getSession: () => session, createRegistry: (lease, model) => buildAiToolRegistry(() => session, channel, () => undefined, lease, { model }), traceWriter });
  const participant = new LineageParticipant({ subscriptions: [] } as unknown as vscode.ExtensionContext, () => session, channel, runtime);
  return { session, participant, lines, records };
}

function model(sendRequest: () => Promise<unknown>): vscode.LanguageModelChat {
  return { id: 'selected-test-model', name: 'Selected test', vendor: 'test', family: 'test', version: '1', maxInputTokens: 128000, countTokens: async () => 1, sendRequest: vi.fn(sendRequest) } as unknown as vscode.LanguageModelChat;
}
const failing = () => model(async () => { throw new Error(PROVIDER_ECHO); });
const answering = () => model(async () => ({ stream: (async function* () { yield new vscode.LanguageModelTextPart('Ask about refund timing.'); })() }));
const stream = { markdown() {}, progress() {}, button() {} } as unknown as vscode.ChatResponseStream;
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) } as vscode.CancellationToken;

describe('participant error settlement', () => {
  it('settles a provider failure once through errorDetails without a second retry instruction', async () => {
    const { participant } = fixture();
    const result = await participant.handleChatRequest({ prompt: BADGE, model: failing() } as vscode.ChatRequest, { history: PRIOR_TURN }, stream, token);
    expect(result.errorDetails?.message).toContain(PROVIDER_ECHO);
    expect(result.errorDetails?.message).not.toMatch(/retry|send the request again/i);
    expect(result.metadata?.status).toBe('error');
  });

  it('keeps provider text out of error-level output and writes it sanitized at debug level', async () => {
    const { participant, lines } = fixture();
    await participant.handleChatRequest({ prompt: BADGE, model: failing() } as vscode.ChatRequest, { history: PRIOR_TURN }, stream, token);
    const terminalErrors = lines.error.filter(line => line.includes('native turn terminal'));
    expect(terminalErrors).toHaveLength(1);
    expect(terminalErrors[0]).toMatch(/status=error/);
    expect(terminalErrors[0]).toMatch(/code=/);
    expect(lines.error.join('\n')).not.toContain(PROVIDER_ECHO);
    const terminalDebug = lines.debug.filter(line => line.includes('native turn failure message'));
    expect(terminalDebug).toHaveLength(1);
    expect(terminalDebug[0]).toContain(PROVIDER_ECHO);
    expect(terminalDebug[0]).not.toMatch(/[\r\n]/);
  });

  it.each([
    ['ok', answering],
    ['error', failing],
  ] as const)('writes paired turn-start and turn-terminal lifecycle records for a %s suggestion turn', async (status, makeModelFor) => {
    const { participant, records } = fixture();
    const result = await participant.handleChatRequest({ prompt: BADGE, model: makeModelFor() } as vscode.ChatRequest, { history: PRIOR_TURN }, stream, token);
    const start = records.find(record => record.type === 'turn-start');
    const terminal = records.find(record => record.type === 'turn-terminal');
    expect(start).toMatchObject({ requestId: result.metadata?.requestId });
    expect(terminal).toMatchObject({ requestId: result.metadata?.requestId, status, modelCalls: 1 });
    expect(start && 'runFingerprint' in start && start.runFingerprint).toBe(terminal && 'runFingerprint' in terminal && terminal.runFingerprint);
    expect(JSON.stringify(records)).not.toContain(PROVIDER_ECHO);
  });
});
