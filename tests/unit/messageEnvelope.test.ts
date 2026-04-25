/**
 * Unit tests for the structural validator that backs MessageEnvelope.
 *
 * The thin VS Code wrapper at src/ai/messageEnvelope.ts cannot be exercised
 * under tsx (no `vscode` runtime). The pure validator in messageEnvelopeCore.ts
 * is the meaningful surface — it owns the tool_use ↔ tool_result invariant and
 * the trailing-pair detection. These tests reproduce the live HTTP-400 from
 * 2026-04-25 (sess_1777097046201_u9gf9) as a structural fixture and confirm
 * the validator catches it.
 */

import { assert, assertEq, printSummary, resetCounters } from './helpers/testUtils';
import {
  assertWellFormedShape,
  findLastToolPairShape,
  MessageEnvelopeInvariantError,
  type MessageShape,
} from '../../src/ai/messageEnvelopeCore';

console.log('MessageEnvelope structural validator');
console.log('='.repeat(40));
resetCounters();

const u = (...kinds: Array<{ kind: 'text' | 'tool_use' | 'tool_result'; callId?: string }>): MessageShape =>
  ({ role: 'user', parts: kinds });
const a = (...kinds: Array<{ kind: 'text' | 'tool_use' | 'tool_result'; callId?: string }>): MessageShape =>
  ({ role: 'assistant', parts: kinds });

function expectThrow(fn: () => void, name: string, contains?: string): void {
  try {
    fn();
    assert(false, `${name} — expected throw, but did not throw`);
  } catch (err) {
    if (!(err instanceof MessageEnvelopeInvariantError)) {
      assert(false, `${name} — threw wrong error type: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (contains && !err.message.includes(contains)) {
      assert(false, `${name} — error message missing "${contains}": ${err.message}`);
      return;
    }
    assert(true, `${name} — threw expected MessageEnvelopeInvariantError`);
  }
}

// ─── 1. Well-formed envelopes pass ──────────────────────────────────────────
console.log('\n── well-formed envelopes pass ──');
{
  // Empty envelope is trivially well-formed (no tool_results to orphan).
  assertWellFormedShape([]);
  assert(true, 'empty array passes');

  // Seed only.
  assertWellFormedShape([u({ kind: 'text' }), u({ kind: 'text' })]);
  assert(true, 'seed without any tool turns passes');

  // Seed + one full turn.
  assertWellFormedShape([
    u({ kind: 'text' }),
    u({ kind: 'text' }),
    a({ kind: 'tool_use', callId: 'X' }),
    u({ kind: 'tool_result', callId: 'X' }),
  ]);
  assert(true, 'seed + one matched tool turn passes');

  // Multiple consecutive turns.
  assertWellFormedShape([
    u({ kind: 'text' }),
    u({ kind: 'text' }),
    a({ kind: 'tool_use', callId: 'X' }),
    u({ kind: 'tool_result', callId: 'X' }),
    a({ kind: 'tool_use', callId: 'Y' }),
    u({ kind: 'tool_result', callId: 'Y' }),
  ]);
  assert(true, 'two consecutive matched turns pass');
}

// ─── 2. Reproduces the live HTTP-400 ─────────────────────────────────────────
console.log('\n── reproduces 2026-04-25 sess_1777097046201_u9gf9 ──');
{
  // Synthesis-corrective at lineageParticipant.ts:538-553 dropped the parent
  // Assistant tool_use when copying the User tool_result. The result is four
  // consecutive User messages; Bedrock User-merge would collapse them and the
  // backend rejects with `messages.0.content.2: unexpected tool_use_id`.
  const collapsed: MessageShape[] = [
    u({ kind: 'text' }),                                    // systemPrompt
    u({ kind: 'text' }),                                    // effectivePrompt
    u({ kind: 'tool_result', callId: 'toolu_bdrk_X' }),     // orphaned (parent dropped)
    u({ kind: 'text' }),                                    // corrective text
  ];
  expectThrow(
    () => assertWellFormedShape(collapsed),
    'orphan tool_result with no preceding Assistant',
    'has no preceding Assistant message',
  );
}

// ─── 3. Mismatch on callId is caught ─────────────────────────────────────────
console.log('\n── callId mismatch ──');
{
  const mismatch: MessageShape[] = [
    u({ kind: 'text' }),
    u({ kind: 'text' }),
    a({ kind: 'tool_use', callId: 'A' }),
    u({ kind: 'tool_result', callId: 'B' }),
  ];
  expectThrow(
    () => assertWellFormedShape(mismatch),
    'tool_result.callId without matching tool_use',
    'no matching tool_use',
  );
}

// ─── 4. Assistant with text but no tool_use does not satisfy a tool_result ──
console.log('\n── Assistant message must carry a tool_use ──');
{
  const textOnlyAssistant: MessageShape[] = [
    u({ kind: 'text' }),
    a({ kind: 'text' }),
    u({ kind: 'tool_result', callId: 'X' }),
  ];
  expectThrow(
    () => assertWellFormedShape(textOnlyAssistant),
    'preceding Assistant has no tool_use part',
    'no matching tool_use',
  );
}

// ─── 5. tool_use without tool_result is allowed (in-flight turn) ─────────────
console.log('\n── pending tool_use without result is allowed ──');
{
  // The participant pushes Assistant(tool_use) before invoking the tool; the
  // tool_result is pushed afterwards. Between those points the array is
  // structurally valid for the next round's send (no orphaned result).
  assertWellFormedShape([
    u({ kind: 'text' }),
    u({ kind: 'text' }),
    a({ kind: 'tool_use', callId: 'X' }),
  ]);
  assert(true, 'tool_use without trailing tool_result is allowed');
}

// ─── 6. Multiple tool_results in one User message must all match ─────────────
console.log('\n── parallel tool calls in one Assistant turn ──');
{
  const ok: MessageShape[] = [
    u({ kind: 'text' }),
    u({ kind: 'text' }),
    a({ kind: 'tool_use', callId: 'X' }, { kind: 'tool_use', callId: 'Y' }),
    u({ kind: 'tool_result', callId: 'X' }, { kind: 'tool_result', callId: 'Y' }),
  ];
  assertWellFormedShape(ok);
  assert(true, 'parallel calls with both ids paired pass');

  const partial: MessageShape[] = [
    u({ kind: 'text' }),
    u({ kind: 'text' }),
    a({ kind: 'tool_use', callId: 'X' }),
    u({ kind: 'tool_result', callId: 'X' }, { kind: 'tool_result', callId: 'Y' }),
  ];
  expectThrow(
    () => assertWellFormedShape(partial),
    'parallel tool_results with one orphan',
    'no matching tool_use',
  );
}

// ─── 7. findLastToolPairShape — happy path ───────────────────────────────────
console.log('\n── findLastToolPairShape locates the trailing pair ──');
{
  const msgs: MessageShape[] = [
    u({ kind: 'text' }),
    u({ kind: 'text' }),
    a({ kind: 'tool_use', callId: 'X' }),
    u({ kind: 'tool_result', callId: 'X' }),
  ];
  const hit = findLastToolPairShape(msgs);
  assert(hit !== undefined, 'pair found');
  assertEq(hit?.assistantIdx, 2, 'assistant index correct');
  assertEq(hit?.resultIdx, 3, 'result index correct');
}

// ─── 8. findLastToolPairShape — tail is text, not result ─────────────────────
console.log('\n── findLastToolPairShape returns undefined when tail is not a result ──');
{
  const msgs: MessageShape[] = [
    u({ kind: 'text' }),
    a({ kind: 'tool_use', callId: 'X' }),
    u({ kind: 'tool_result', callId: 'X' }),
    u({ kind: 'text' }),
  ];
  const hit = findLastToolPairShape(msgs);
  assert(hit === undefined, 'no pair when tail is plain text');
}

// ─── 9. findLastToolPairShape — tail is result but no parent assistant ──────
console.log('\n── findLastToolPairShape returns undefined when parent assistant missing ──');
{
  const msgs: MessageShape[] = [
    u({ kind: 'text' }),
    u({ kind: 'text' }),
    u({ kind: 'tool_result', callId: 'X' }),
  ];
  const hit = findLastToolPairShape(msgs);
  assert(hit === undefined, 'no pair when assistant slot is User text');
}

// ─── 10. Snapshot string is compact and informative ──────────────────────────
console.log('\n── snapshot string includes role + kind tags ──');
{
  const { snapshotShape } = require('../../src/ai/messageEnvelopeCore') as typeof import('../../src/ai/messageEnvelopeCore');
  const snap = snapshotShape([
    u({ kind: 'text' }),
    a({ kind: 'tool_use', callId: 'aaaaaaXY' }),
    u({ kind: 'tool_result', callId: 'aaaaaaXY' }),
  ]);
  assert(snap.includes('[0]U{t}'), 'snapshot tags index 0 as User text');
  assert(snap.includes('A{c:'), 'snapshot tags Assistant tool_use as c:');
  assert(snap.includes('U{r:'), 'snapshot tags User tool_result as r:');
  assert(snap.includes('aaXY'), 'snapshot truncates callId to tail 6 chars');
}

printSummary('MessageEnvelope structural validator');
