/**
 * A bounded prompt block (discovery evidence, replayed transcript, held tool evidence) may claim
 * 12.5 % of the model's input window, measured with the one token counter the rest of the budget
 * runs on (`countTokens`: o200k times the safety margin). A byte ceiling at four bytes per token
 * admits more than that on identifier-dense JSON, which runs under four bytes per counted token
 * (2.3 for the rows here), so each block is checked by its token count, not its size in bytes.
 */
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { executeToolAttempt } from '../../../src/ai/agent/toolAttempt';
import type { ConverseInstructionPlan } from '../../../src/ai/agent/instructionPlan';
import { AiSession } from '../../../src/ai/session/session';
import { calibrateTurnBudget } from '../../../src/ai/support/tokenBudget';
import { countTokens } from '../../../src/ai/support/tokenCount';
import { collectingSink, ScriptedModelPort, scriptedRegistry, validCall } from '../../harness/scriptedModelPort';

/** A 32k window: a block may hold 4 096 counted tokens, a stored evidence kind 3 072. */
const WINDOW_TOKENS = 32_768;
const BLOCK_TOKENS = WINDOW_TOKENS * 0.125;
const EVIDENCE_KIND_TOKENS = BLOCK_TOKENS - 1_024;

/** A `lineage_search_objects`-shaped result of `rows` identifier-dense rows. */
function searchResult(seed: string, rows: number): string {
  return JSON.stringify({
    results: Array.from({ length: rows }, (_, i) => ({
      id: `[ai].[${seed}table${i}]`, s: 'ai', n: `${seed}Table${i}`, t: 'table', deg: 3, match: 'name', in_user_filter: true,
    })),
  });
}

/** Text of every message of the session's discovery history, as the model receives it. */
function historyText(session: AiSession): string {
  return session.getDiscoveryHistory()
    .map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))
    .join('\n');
}

describe('discovery blocks are bounded by counted tokens', () => {
  const budget = calibrateTurnBudget(WINDOW_TOKENS);

  it('evicts evidence until the retained block fits its token share', () => {
    const session = new AiSession();
    for (let i = 0; i < 10; i += 1) {
      // Each result is about 3 KB, far under the per-observation cap, so only the block bound evicts.
      session.appendDiscoveryTurn(budget, [], [{ toolName: 'lineage_search_objects', result: searchResult(`o${i}`, 30) }]);
    }
    const history = historyText(session);
    expect(history).not.toBe('');
    expect(countTokens(history)).toBeLessThanOrEqual(BLOCK_TOKENS);
  });

  it('drops one observation whose tokens exceed the evidence-kind share', () => {
    const session = new AiSession();
    // About 10 KB: under a four-bytes-per-token byte cap, over the counted-token cap.
    const result = searchResult('big', 100);
    expect(countTokens(result)).toBeGreaterThan(EVIDENCE_KIND_TOKENS);
    session.appendDiscoveryTurn(budget, [], [{ toolName: 'lineage_search_objects', result }]);
    expect(historyText(session)).toBe('');
  });

  it('evicts transcript turns until the retained transcript fits its token share', () => {
    const session = new AiSession();
    for (let i = 0; i < 6; i += 1) {
      session.appendDiscoveryTurn(budget, [new HumanMessage(searchResult(`u${i}`, 30)), new AIMessage(searchResult(`a${i}`, 30))]);
    }
    const history = historyText(session);
    expect(history).not.toBe('');
    expect(countTokens(history)).toBeLessThanOrEqual(BLOCK_TOKENS);
  });
});

describe('held tool evidence is bounded by counted tokens', () => {
  it('refuses a read that would take the held evidence past its token share', async () => {
    const budget = calibrateTurnBudget(WINDOW_TOKENS);
    const a = searchResult('a', 50);
    const b = searchResult('b', 50);
    // Together under a four-bytes-per-token byte cap, over the counted-token cap.
    expect(countTokens(a) + countTokens(b)).toBeGreaterThan(EVIDENCE_KIND_TOKENS);
    expect(countTokens(a)).toBeLessThan(EVIDENCE_KIND_TOKENS);
    const model = new ScriptedModelPort([
      { toolCalls: [validCall('c1', 'lineage_search_objects', { query: 'a' }), validCall('c2', 'lineage_search_objects', { query: 'b' })] },
    ], [], [], budget);
    const { registry } = scriptedRegistry([
      { name: 'lineage_search_objects', effect: 'read', result: (input) => ((input as { query: string }).query === 'a' ? a : b) },
    ]);
    const { sink } = collectingSink();
    const plan = {
      kind: 'converse',
      context: {},
      frame: { phase: 'scoping' },
      input: { messages: [new HumanMessage('find tables')], registry, sink, phase: 'scoping', instructionContext: {} },
    } as unknown as ConverseInstructionPlan;

    const result = await executeToolAttempt(model, plan);

    expect(result.observations.map((observation) => observation.refused ?? false)).toEqual([false, true]);
    expect(result.observations[1]!.result).toContain('result_too_large');
  });
});
