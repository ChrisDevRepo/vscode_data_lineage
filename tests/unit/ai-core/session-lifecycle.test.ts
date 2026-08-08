import { describe, expect, it } from 'vitest';
import { AiSession } from '../../../src/ai/session/session';

const renderedResult = {
  name: 'Rendered view',
  nodeIds: ['[dbo].[Source]'],
  aiMetadata: {
    description: 'Rendered detail',
    summary: 'Rendered summary',
    createdAt: '2026-08-02T00:00:00.000Z',
    modelName: 'test-model',
    highlightGroups: [{ label: 'Source', color: 'source' as const, nodeIds: ['[dbo].[Source]'] }],
    badges: [],
  },
};

function populatePresentation(session: AiSession, token: number): void {
  expect(session.beginPresentResultAttempt(token).kind).toBe('accepted');
  expect(session.recordPresentResultFailure(token, 'invalid sections').kind).toBe('accepted');
  expect(session.commitPresentResultSuccess(token, renderedResult).kind).toBe('accepted');
}

describe('AiSession lifecycle ownership', () => {
  it('owns guarded present-result attempt, failure, and success state', () => {
    const session = new AiSession();
    const firstTurn = session.beginTurn();
    populatePresentation(session, firstTurn);

    expect(session.presentResultAttemptCountThisTurn).toBe(1);
    expect(session.presentResultFailureCountThisTurn).toBe(1);
    expect(session.presentResultLastFailureReasonThisTurn).toBe('invalid sections');
    expect(session.presentResultCalledThisTurn).toBe(true);
    expect(session.lastPresentResultDescription).toBe('Rendered detail');
    expect(session.lastPresentResultSummary).toBe('Rendered summary');
    expect(session.lastPresentResultHighlightGroups).toEqual([
      { label: 'Source', color: 'source', nodeIds: ['[dbo].[Source]'] },
    ]);

    const secondTurn = session.beginTurn();
    expect(secondTurn).not.toBe(firstTurn);
    for (const staleWrite of [
      () => session.beginPresentResultAttempt(firstTurn),
      () => session.recordPresentResultFailure(firstTurn, 'stale failure'),
      () => session.commitPresentResultSuccess(firstTurn, renderedResult),
    ]) {
      expect(staleWrite().kind).toBe('dropped_stale_turn');
    }

    expect(session.presentResultAttemptCountThisTurn).toBe(1);
    expect(session.presentResultFailureCountThisTurn).toBe(1);
    expect(session.lastPresentResultSummary).toBe('Rendered summary');
  });

  it('updates and resets memory-wipe counters atomically with guarded events', () => {
    const session = new AiSession();
    const firstTurn = session.beginTurn();

    expect(session.recordMemoryWipeEvent(firstTurn, {
      kind: 'sliding',
      trigger: 'submit_ok',
      hop: 2,
      messagesBefore: 7,
    }).kind).toBe('accepted');
    expect(session.slidingMemoryWipeCountThisTurn).toBe(1);
    expect(session.memoryWipeEventsThisTurn).toHaveLength(1);

    const secondTurn = session.beginTurn();
    expect(session.recordMemoryWipeEvent(firstTurn, {
      kind: 'sliding',
      trigger: 'stale',
      hop: 99,
      messagesBefore: 99,
    }).kind).toBe('dropped_stale_turn');
    expect(session.slidingMemoryWipeCountThisTurn).toBe(1);
    expect(session.memoryWipeEventsThisTurn).toHaveLength(1);

    expect(session.recordMemoryWipeEvent(secondTurn, {
      kind: 'sliding',
      trigger: 'submit_ok',
      hop: 3,
      messagesBefore: 5,
    }).kind).toBe('accepted');
    expect(session.slidingMemoryWipeCountThisTurn).toBe(2);
    expect(session.memoryWipeEventsThisTurn).toHaveLength(2);

    session.beginTurnState();
    expect(session.slidingMemoryWipeCountThisTurn).toBe(0);
    expect(session.memoryWipeEventsThisTurn).toHaveLength(0);
  });

  it('centralizes exploration-level presentation reset', () => {
    const session = new AiSession();
    const token = session.beginTurn();
    populatePresentation(session, token);

    session.resetExploration();

    expect(session.presentResultCalledThisTurn).toBe(false);
    expect(session.presentResultAttemptCountThisTurn).toBe(0);
    expect(session.presentResultFailureCountThisTurn).toBe(0);
    expect(session.presentResultLastFailureReasonThisTurn).toBeNull();
    expect(session.lastPresentResultDescription).toBeNull();
    expect(session.lastPresentResultSummary).toBeNull();
    expect(session.lastPresentResultHighlightGroups).toBeNull();
  });

  it('retains preview scope across a turn and resets auto-dispatch with presentation state', () => {
    const session = new AiSession();
    const token = session.beginTurn();
    session.discoveryScopeArtifact = {
      turnEpoch: token,
      origin: '[dbo].[Source]',
      direction: 'upstream',
      nodeIds: ['[dbo].[Source]'],
      edges: [],
    };
    session.beginTurnState();
    expect(session.discoveryScopeArtifact?.origin).toBe('[dbo].[Source]');

    expect(session.commitPresentResultSuccess(token, renderedResult, true).kind).toBe('accepted');
    expect(session.presentResultAutoDispatched).toBe(true);
    session.clearPresentResultFlag();
    expect(session.presentResultAutoDispatched).toBe(false);
  });
});
