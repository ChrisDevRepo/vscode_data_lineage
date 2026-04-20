/**
 * Unit tests for AiSession stale-timer behavior.
 *
 * Covers the bug fix where a long-idle confirm_sm_start gate resume (62+ min
 * in the original incident) triggered resetIfStale() on the next
 * start_exploration call, wiping the primed engine and deadlocking the turn.
 */

import { assert, printSummary } from './helpers/testUtils';
import { AiSession } from '../../src/ai/session';

function withMockedNow<T>(nowMs: number, fn: () => T): T {
  const realNow = Date.now;
  Date.now = () => nowMs;
  try { return fn(); } finally { Date.now = realNow; }
}

async function runTests() {
  console.log('\n══════ session-stale tests ══════');

  console.log('\n── touch() and isStale() ──');

  // Fresh session is not stale.
  {
    const t0 = 1_000_000_000_000;
    const sess = withMockedNow(t0, () => new AiSession());
    assert(!withMockedNow(t0, () => sess.isStale()), 'fresh session is not stale');
  }

  // Untouched session crosses stale threshold after 30 min.
  {
    const t0 = 1_000_000_000_000;
    const sess = withMockedNow(t0, () => new AiSession());
    const thirtyOneMin = 31 * 60 * 1000;
    assert(withMockedNow(t0 + thirtyOneMin, () => sess.isStale()), '31 min without activity → stale');
  }

  // touch() resets staleness — gate-resume-after-idle scenario.
  {
    const t0 = 1_000_000_000_000;
    const sess = withMockedNow(t0, () => new AiSession());
    const sixtyTwoMin = 62 * 60 * 1000;
    assert(withMockedNow(t0 + sixtyTwoMin, () => sess.isStale()), '62 min idle → stale before touch');
    withMockedNow(t0 + sixtyTwoMin, () => sess.touch());
    assert(!withMockedNow(t0 + sixtyTwoMin + 1000, () => sess.isStale()), 'after touch, not stale');
    const fifteenMinAfterTouch = t0 + sixtyTwoMin + 15 * 60 * 1000;
    assert(!withMockedNow(fifteenMinAfterTouch, () => sess.isStale()), '15 min after touch, still not stale');
    const thirtyOneMinAfterTouch = t0 + sixtyTwoMin + 31 * 60 * 1000;
    assert(withMockedNow(thirtyOneMinAfterTouch, () => sess.isStale()), '31 min after touch, stale again');
  }

  // resetIfStale on a fresh-touched, long-elapsed session is a no-op.
  {
    const t0 = 1_000_000_000_000;
    const sess = withMockedNow(t0, () => new AiSession());
    const originalId = sess.id;
    // Simulate the incident: 62 min idle, then gate-resume touches the session.
    withMockedNow(t0 + 62 * 60 * 1000, () => sess.touch());
    // The subsequent start_exploration call happens moments later.
    withMockedNow(t0 + 62 * 60 * 1000 + 5000, () => sess.resetIfStale());
    assert(sess.id === originalId, 'resetIfStale is a no-op after touch — session id preserved');
  }

  // regenerateSessionId updates lastActivity too.
  {
    const t0 = 1_000_000_000_000;
    const sess = withMockedNow(t0, () => new AiSession());
    const later = t0 + 60 * 60 * 1000;
    withMockedNow(later, () => sess.regenerateSessionId());
    assert(!withMockedNow(later + 1000, () => sess.isStale()), 'regenerateSessionId resets lastActivity');
  }

  printSummary('session-stale');
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
