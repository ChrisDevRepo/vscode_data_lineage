/**
 * `AiSession.appendDiscoveryTurn` must never silently drop a discovery observation or evict
 * transcript/evidence history — every drop or eviction is NORMALIZE-WITH-LOG, observable through
 * the caller-supplied `debugLog` sink.
 */
import { describe, expect, it } from 'vitest';
import {
  AiSession,
  MAX_DISCOVERY_EVIDENCE_OBSERVATIONS,
  MAX_DISCOVERY_TRANSCRIPT_TURNS,
  type DiscoveryEvidenceObservation,
} from '../../../src/ai/session/session';
import { modelAssistantMessage, modelUserMessage, type ModelMessage } from '../../../src/ai/model/modelPort';
import { createTurnTokenBudget, discoveryEvidenceItemBytes } from '../../../src/ai/support/tokenBudget';

const budget = createTurnTokenBudget({ modelWindowTokens: 16_384 });

function turn(i: number): ModelMessage[] {
  return [modelUserMessage(`question ${i}`), modelAssistantMessage(`answer ${i}`)];
}

describe('AiSession.appendDiscoveryTurn — whole-observation drops are NORMALIZE-WITH-LOG', () => {
  it('logs an oversized observation instead of a silent continue', () => {
    const session = new AiSession();
    const logs: string[] = [];
    const oversized = 'x'.repeat(discoveryEvidenceItemBytes(budget) + 1_000);
    session.appendDiscoveryTurn(
      budget,
      turn(1),
      [{ toolName: 'lineage_get_object_detail', result: oversized }],
      message => logs.push(message),
    );
    expect(logs.some(l => l.includes('[AI] [Discovery] evidence observation dropped') && l.includes('reason=oversized')),
      'the oversized drop is reported, naming the tool').toBe(true);
    expect(logs.some(l => l.includes('lineage_get_object_detail'))).toBe(true);
  });

  it('logs an unparseable observation instead of a silent continue', () => {
    const session = new AiSession();
    const logs: string[] = [];
    session.appendDiscoveryTurn(
      budget,
      turn(1),
      [{ toolName: 'lineage_search_objects', result: '{not valid json' }],
      message => logs.push(message),
    );
    expect(logs.some(l => l.includes('reason=unparseable') && l.includes('lineage_search_objects'))).toBe(true);
  });

  it('logs an error-envelope observation instead of a silent continue', () => {
    const session = new AiSession();
    const logs: string[] = [];
    session.appendDiscoveryTurn(
      budget,
      turn(1),
      [{ toolName: 'lineage_get_object_detail', result: JSON.stringify({ error: 'not_found', hint: 'x' }) }],
      message => logs.push(message),
    );
    expect(logs.some(l => l.includes('reason=error_envelope'))).toBe(true);
  });

  it('logs a missing tool name instead of a silent continue', () => {
    const session = new AiSession();
    const logs: string[] = [];
    const badObservation = { toolName: '', result: '{}' } as DiscoveryEvidenceObservation;
    session.appendDiscoveryTurn(budget, turn(1), [badObservation], message => logs.push(message));
    expect(logs.some(l => l.includes('reason=missing_tool_name'))).toBe(true);
  });

  it('accepts a well-formed observation without logging a drop', () => {
    const session = new AiSession();
    const logs: string[] = [];
    session.appendDiscoveryTurn(
      budget,
      turn(1),
      [{ toolName: 'lineage_search_objects', result: JSON.stringify({ matches: [] }) }],
      message => logs.push(message),
    );
    expect(logs.some(l => l.includes('dropped'))).toBe(false);
  });

  it('never throws when no debugLog callback is supplied — logging stays optional', () => {
    const session = new AiSession();
    expect(() => session.appendDiscoveryTurn(
      budget,
      turn(1),
      [{ toolName: 'lineage_get_object_detail', result: 'x'.repeat(discoveryEvidenceItemBytes(budget) + 10) }],
    )).not.toThrow();
  });
});

describe('AiSession.appendDiscoveryTurn — eviction under the transcript/evidence caps is NORMALIZE-WITH-LOG', () => {
  it('logs the oldest transcript turn and the oldest evidence observation when the caps evict them', () => {
    const session = new AiSession();
    const logs: string[] = [];
    const rounds = Math.max(MAX_DISCOVERY_TRANSCRIPT_TURNS, MAX_DISCOVERY_EVIDENCE_OBSERVATIONS) + 5;
    for (let i = 1; i <= rounds; i++) {
      session.appendDiscoveryTurn(
        budget,
        turn(i),
        [{ toolName: 'lineage_search_objects', result: JSON.stringify({ ok: i }) }],
        message => logs.push(message),
      );
    }
    expect(logs.some(l => l.includes('[AI] [Discovery] oldest transcript turn evicted')),
      'a transcript-turn eviction beyond the cap is observable').toBe(true);
    expect(logs.some(l => l.includes('[AI] [Discovery] oldest evidence observation evicted')),
      'an evidence eviction beyond the cap is observable').toBe(true);
  });
});
