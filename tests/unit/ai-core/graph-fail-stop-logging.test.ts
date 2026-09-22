/**
 * Severity cover for the budget-stop terminal in `src/ai/agent/graph.ts` (`failStopped`).
 *
 * @remarks
 * A tripped attempt budget is the one lifecycle record written at ERROR, so it is also the one
 * place a rejection's prose could reach a default-on log. The convention splits the two: the
 * error line carries the stop code, the phase, the counters, the last rejection's tool and code,
 * and its issue paths — all content-free — while the AI/Zod rejection prose, which is normal model
 * behaviour, rides the paired DEBUG line. Driven through the real graph wiring so the split is
 * pinned where it is emitted, not on a re-implementation of the format.
 */
import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../../../src/ai/host/agentRuntime';
import type { ModelPort } from '../../../src/ai/model/modelPort';
import { PREVIEW_REQUEST_MARKER } from '../../../src/ai/prompting/prompts';
import { MAX_TOOL_SEMANTIC_FAILURES } from '../../../src/ai/agent/toolAttempt';
import { TurnEventSink } from '../../../src/ai/runtime/turnEventSink';
import { AiSession } from '../../../src/ai/session/session';
import { Logger } from '../../../src/utils/log';
import { ScriptedModelPort, invalidCall, scriptedRegistry } from './helpers/scriptedModelPort';

/** The Zod prose the provider's prevalidation produced — model-facing text, never a lifecycle field. */
const REJECTION_PROSE = 'sections.0.text: Required — write the business capture before presenting.';
const ISSUE_PATH = 'sections.0.text';

/** Every line the logger wrote, by level. */
type CapturedLines = Record<'info' | 'debug' | 'warn' | 'error', string[]>;

/** Captures every channel line by level, standing in for the VS Code `LogOutputChannel`. */
function capturingChannel(): { channel: Parameters<typeof Logger.create>[0]; lines: CapturedLines } {
  const lines: CapturedLines = { info: [], debug: [], warn: [], error: [] };
  const channel = {
    info: (line: string) => lines.info.push(line),
    debug: (line: string) => lines.debug.push(line),
    warn: (line: string) => lines.warn.push(line),
    error: (line: string) => lines.error.push(line),
  } as unknown as Parameters<typeof Logger.create>[0];
  return { channel, lines };
}

/**
 * Runs a visual-preview turn whose every attempt is rejected before dispatch, tripping the
 * semantic-failure budget and landing on `failStopped`.
 */
async function runToSemanticStop() {
  const session = new AiSession();
  const epoch = session.beginTurn();
  // The post-discovery state the preview pill re-enters with: a cached scope and answer.
  session.storeDiscoveryScope({
    turnEpoch: epoch,
    origin: '[ai].[Origin]',
    direction: 'upstream',
    nodeIds: ['[ai].[Origin]'],
    edges: [],
  }, epoch);
  session.recordDiscovery('[ai].[Origin]', 1, 'What feeds Origin?', 'Origin has no upstream dependencies.');

  const { registry, invocations } = scriptedRegistry([
    { name: 'lineage_present_result', result: '{"ok":true}' },
  ]);
  // Every generation is refused by prevalidation, so the phase never reaches an accepted terminal.
  const script = Array.from({ length: MAX_TOOL_SEMANTIC_FAILURES }, (_, i) => ({
    toolCalls: [invalidCall(`present-${i}`, 'lineage_present_result', 'invalid_tool_input', REJECTION_PROSE, [ISSUE_PATH])],
  }));
  const model = new ScriptedModelPort(script);
  const { channel, lines } = capturingChannel();
  const runtime = new AgentRuntime({
    threadId: 'fail-stop-logging',
    getSession: () => session,
    model: model as unknown as ModelPort,
    registry,
    sink: new TurnEventSink(() => {}),
    turnEpoch: epoch,
    maxRounds: 10,
    logger: Logger.create(channel, 'AI'),
  });

  const outcome = await runtime.run(PREVIEW_REQUEST_MARKER);
  return { outcome, lines, invocations, runtime };
}

describe('failStopped — a tripped budget logs a content-free error and the prose at debug', () => {
  it('keeps the rejection prose out of the error line and names the stop, tool, code, and paths', async () => {
    const { outcome, lines, invocations } = await runToSemanticStop();

    expect(outcome, 'the turn ends on the tripped budget').toBe('error');
    expect(invocations, 'no call ever reached dispatch — every one was refused by prevalidation').toHaveLength(0);

    const stopLine = lines.error.find(line => line.includes('reason=semantic_failures'));
    expect(stopLine, `the budget stop is recorded at error (saw ${JSON.stringify(lines.error)})`).toBeDefined();
    expect(stopLine, 'the phase is recoverable from the trace').toContain('phase=');
    expect(stopLine, 'and both counters').toContain(`semanticFailures=${MAX_TOOL_SEMANTIC_FAILURES}`);
    expect(stopLine).toContain('providerCalls=');
    expect(stopLine, 'the last rejection is identified by tool and code').toContain('last=lineage_present_result:invalid_tool_input');
    expect(stopLine, 'and by the field paths it names').toContain(`issuePaths=${ISSUE_PATH}`);
    expect(stopLine, 'but never by its prose').not.toContain('write the business capture');
    expect(
      lines.error.some(line => line.includes(REJECTION_PROSE)),
      'no error-level line carries the rejection prose',
    ).toBe(false);
  });

  it('pairs the stop with its cause at debug, where the prose stays diagnosable', async () => {
    const { lines } = await runToSemanticStop();

    const stopLine = lines.debug.find(line => line.includes('[Stop]'));
    expect(stopLine, `the terminal writes its own debug record (saw ${JSON.stringify(lines.debug)})`).toBeDefined();
    expect(stopLine, 'naming the budget that ended the turn').toContain('reason=semantic_failures');
    expect(stopLine, 'the rejecting tool').toContain('tool=lineage_present_result');
    expect(stopLine, 'its code').toContain('code=invalid_tool_input');
    expect(stopLine, 'and the prose the error line refused to carry').toContain(REJECTION_PROSE);
  });
});
