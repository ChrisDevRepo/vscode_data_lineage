import { AiSession, sameExplorationProposal } from '../../../src/ai/session/session';
import type { SmResult } from '../../../src/ai/sm/smTypes';
import { describe, expect, it } from 'vitest';

describe("session turn-epoch guard tests", () => {
  const sampleResult: SmResult = {
    status: 'complete',
    originNodeId: 'origin',
    fullNodes: [{ id: 'origin', s: 'dbo', n: 'origin', t: 'table' }],
    edges: [],
    detail_slots: [],
    node_states: [],
    columnAspect: null,
  };
  it("enter* epoch guard", () => {
    const sess = new AiSession();
    const t1 = sess.beginTurn();
    const accepted = sess.enterExploring(t1);
    expect(accepted.kind, 'fresh-token enterExploring is accepted').toBe('accepted');
    expect(sess.phase.kind, 'phase advanced to exploring').toBe('exploring');

    // A later turn supersedes t1 without any explicit reset.
    const t2 = sess.beginTurn();
    expect(t2 !== t1, 'beginTurn bumps the epoch (t2 != t1)').toBe(true);

    const stale = sess.enterIdle(t1);
    expect(stale.kind, 'stale-token enterIdle is dropped').toBe('dropped_stale_turn');
    if (stale.kind === 'dropped_stale_turn') {
      expect(stale.op, 'drop names the op').toBe('enterIdle');
      expect(stale.captured, 'drop reports the captured (stale) epoch').toBe(t1);
      expect(stale.current, 'drop reports the current live epoch').toBe(t2);
    }
    expect(sess.phase.kind, 'phase is unchanged after a dropped stale write').toBe('exploring');

    // The live turn's own write still lands.
    const fresh = sess.enterIdle(t2);
    expect(fresh.kind, 'fresh-token enterIdle is accepted').toBe('accepted');
    expect(sess.phase.kind, 'phase advanced to idle on the accepted write').toBe('idle');
  });

  it("storeSmResult epoch guard", () => {
    const sess = new AiSession();
    const t1 = sess.beginTurn();
    const t2 = sess.beginTurn(); // supersede t1 before the stale write

    const stale = sess.storeSmResult(sampleResult, t1);
    expect(stale.kind, 'stale-token storeSmResult is dropped').toBe('dropped_stale_turn');
    expect(sess.resultGraph, 'resultGraph is untouched by a dropped stale write').toBe(null);

    const fresh = sess.storeSmResult(sampleResult, t2);
    expect(fresh.kind, 'fresh-token storeSmResult is accepted').toBe('accepted');
    expect(sess.resultGraph !== null, 'resultGraph is populated by the accepted write').toBe(true);
    expect(sess.resultGraph?.originNodeId, 'resultGraph carries the result origin').toBe('origin');
  });

  it("diagnostics-write epoch guard", () => {
    const sess = new AiSession();
    const t1 = sess.beginTurn();

    // Fresh-token diagnostics writes land.
    const hopOk = sess.setHopCount(t1, 3);
    expect(hopOk.kind, 'fresh-token setHopCount is accepted').toBe('accepted');
    expect(sess.hopCount, 'hopCount updated by the accepted write').toBe(3);

    const evtOk = sess.recordMemoryWipeEvent(t1, { kind: 'sliding', trigger: 'submit_ok', hop: 3, messagesBefore: 7 });
    expect(evtOk.kind, 'fresh-token recordMemoryWipeEvent is accepted').toBe('accepted');
    expect(sess.memoryWipeEventsThisTurn.length, 'wipe event appended by the accepted write').toBe(1);

    // A later turn supersedes t1; the stale writes must be dropped no-ops.
    const t2 = sess.beginTurn();

    const hopStale = sess.setHopCount(t1, 99);
    expect(hopStale.kind, 'stale-token setHopCount is dropped').toBe('dropped_stale_turn');
    if (hopStale.kind === 'dropped_stale_turn') {
      expect(hopStale.op, 'drop names the setHopCount op').toBe('setHopCount');
      expect(hopStale.current, 'drop reports the current live epoch').toBe(t2);
    }
    expect(sess.hopCount, 'hopCount untouched by a dropped stale write').toBe(3);

    const evtStale = sess.recordMemoryWipeEvent(t1, { kind: 'sliding', trigger: 'stale', hop: 99, messagesBefore: 12 });
    expect(evtStale.kind, 'stale-token recordMemoryWipeEvent is dropped').toBe('dropped_stale_turn');
    if (evtStale.kind === 'dropped_stale_turn') {
      expect(evtStale.op, 'drop names the recordMemoryWipeEvent op').toBe('recordMemoryWipeEvent');
    }
    expect(sess.memoryWipeEventsThisTurn.length, 'wipe events untouched by a dropped stale write').toBe(1);

    // The live turn's own writes still land.
    expect(sess.setHopCount(t2, 5).kind, 'fresh-token setHopCount (t2) is accepted').toBe('accepted');
    expect(sess.hopCount, 'hopCount advanced on the accepted t2 write').toBe(5);
    expect(sess.recordMemoryWipeEvent(t2, { kind: 'sliding', trigger: 'submit_ok', hop: 5, messagesBefore: 4 }).kind, 'fresh-token recordMemoryWipeEvent (t2) is accepted').toBe('accepted');
    expect(sess.memoryWipeEventsThisTurn.length, 'wipe event appended on the accepted t2 write').toBe(2);
  });

  it("resetExploration internal path", () => {
    const sess = new AiSession();
    const t1 = sess.beginTurn();
    sess.enterExploring(t1);
    expect(sess.phase.kind, 'precondition: exploring').toBe('exploring');

    const epochBefore = sess.turnEpoch;
    sess.resetExploration();
    expect(sess.phase.kind, 'resetExploration returns to idle via its internal enterIdle').toBe('idle');
    expect(sess.turnEpoch, 'resetExploration does NOT bump the epoch').toBe(epochBefore);
  });

  it("exploration proposal activation", () => {
    const sess = new AiSession();
    const token = sess.beginTurn();
    sess.memory.setUserQuestion('completed question must survive review');
    const proposal = {
      init: {
        question: 'Trace upstream and one downstream level',
        origin: '[dbo].[origin]',
        analysisMode: 'bb' as const,
        direction: 'bidirectional' as const,
        depthIntent: { kind: 'asymmetric' as const, upstream: 'all' as const, downstream: 1 },
      },
      classification: 'technical' as const,
      activeFilter: {
        schemas: [], types: [], hideIsolated: false, focusSchemas: [],
        showExternalRefs: false, externalRefTypes: [],
      },
      summary: {
        hopCount: 2,
        scopeCount: 3,
        origin: '[dbo].[origin]',
        depth: null,
        depthIntent: { kind: 'asymmetric' as const, upstream: 'all' as const, downstream: 1 },
        direction: 'bidirectional' as const,
        analysisMode: 'bb' as const,
        columnAspectActive: false,
        estimatedDdlChars: 0,
        estimatedDdlTokens: 0,
        bySchema: {},
        scopeNotes: [],
        activeFilters: { schemas: [], types: [], nodeIds: [], passNodeIds: [] },
      },
    };

    expect(sess.storePendingExploration(proposal, token).kind, 'fresh proposal is stored').toBe('accepted');
    expect(sess.pendingExploration?.revision, 'first proposal receives revision 1').toBe(1);
    expect(sess.stateMachine, 'proposal preview does not publish an engine before approval').toBe(null);
    expect(sess.classification, 'proposal preview does not lock classification before approval').toBe(undefined);
    expect(sess.phase.kind, 'proposal storage alone does not enter exploring').toBe('idle');

    let staleFactoryCalled = false;
    const stale = sess.activatePendingExploration(99, token, () => {
      staleFactoryCalled = true;
      return {} as any;
    });
    expect(stale.kind, 'stale proposal revision is rejected').toBe('rejected');
    expect(!staleFactoryCalled, 'stale revision is rejected before engine construction').toBe(true);
    expect(sess.stateMachine, 'stale approval leaves active engine untouched').toBe(null);
    expect(sess.pendingExploration?.revision, 'stale approval preserves the reviewable proposal').toBe(1);

    const failed = sess.activatePendingExploration(1, token, () => ({ error: 'init_failed' }));
    expect(failed.kind, 'failed engine initialization rejects activation').toBe('rejected');
    expect(sess.stateMachine, 'failed activation publishes no partial engine').toBe(null);
    expect(sess.pendingExploration?.revision, 'failed activation preserves the proposal for review/retry').toBe(1);
    expect(sess.memory.getUserQuestion(), 'failed activation leaves stable session memory unchanged').toBe('completed question must survive review');

    const publishFailed = sess.activatePendingExploration(1, token, () => ({
      status: 'initialized',
      publishMemoryTo(target: AiSession['memory']) {
        target.setUserQuestion('partial publish');
        throw new Error('publish_failed');
      },
    } as any));
    expect(publishFailed.kind, 'memory publication failure rejects activation').toBe('rejected');
    expect(sess.stateMachine, 'memory publication failure publishes no engine').toBe(null);
    expect(sess.pendingExploration?.revision, 'memory publication failure preserves the proposal').toBe(1);
    expect(sess.memory.getUserQuestion(), 'memory publication failure rolls back session memory').toBe('completed question must survive review');

    const approvedEngine = {
      status: 'initialized',
      publishMemoryTo(target: AiSession['memory']) {
        target.reset();
        target.setUserQuestion('new approved question');
      },
    } as any;
    const approved = sess.activatePendingExploration(1, token, (reviewed) => {
      expect(reviewed.init.depthIntent?.kind, 'factory receives the exact reviewed depth intent').toBe('asymmetric');
      return approvedEngine;
    });
    expect(approved.kind, 'matching proposal revision activates').toBe('accepted');
    expect(sess.stateMachine, 'approved engine is published atomically').toBe(approvedEngine);
    expect(sess.pendingExploration, 'approved proposal is consumed').toBe(null);
    expect(sess.classification, 'approved classification becomes active').toBe('technical');
    expect(sess.phase.kind, 'successful activation enters exploring').toBe('exploring');
    expect(sess.memory.getUserQuestion(), 'validated engine memory publishes only at approval').toBe('new approved question');
  });

  it("completed proposal preservation", () => {
    const sess = new AiSession();
    const token = sess.beginTurn();
    const completedEngine = { status: 'complete', publishMemoryTo() {} } as any;
    sess.stateMachine = completedEngine;
    sess.memory.setUserQuestion('completed answer');
    sess.storeSmResult(sampleResult, token);
    sess.enterCompleted(token);
    const completedResult = sess.resultGraph;
    const proposal = {
      init: { question: 'replacement', origin: 'origin', analysisMode: 'bb' as const, direction: 'upstream' as const },
      classification: 'business' as const,
      activeFilter: { schemas: [], types: [], hideIsolated: false, focusSchemas: [], showExternalRefs: false, externalRefTypes: [] },
      summary: {
        hopCount: 1, scopeCount: 1, origin: 'origin', depth: 3,
        depthIntent: { kind: 'default_start' as const }, direction: 'upstream' as const,
        analysisMode: 'bb' as const, columnAspectActive: false,
        estimatedDdlChars: 0, estimatedDdlTokens: 0, bySchema: {},
        scopeNotes: [],
        activeFilters: { schemas: [], types: [], nodeIds: [], passNodeIds: [] },
      },
    };
    sess.storePendingExploration(proposal, token);
    expect(sameExplorationProposal(proposal, sess.pendingExploration!), 'revision is ignored when detecting a no-op refine').toBe(true);
    sess.enterGate({ gate: 'confirm_sm_start', classes: [], nodeIds: [], detail: 'replacement', proposalRevision: 1 }, token);
    expect(sess.stateMachine, 'completed engine remains published during proposal review').toBe(completedEngine);
    expect(sess.resultGraph, 'completed result remains published during proposal review').toBe(completedResult);
    expect(sess.memory.getUserQuestion(), 'completed memory remains intact during proposal review').toBe('completed answer');

    const cancelled = sess.cancelPendingExploration(token);
    expect(cancelled.kind, 'proposal cancel is accepted for the owning turn').toBe('accepted');
    expect(sess.phase.kind, 'cancel returns to the preserved completed phase').toBe('completed');
    expect(sess.pendingExploration, 'cancel clears only the pending replacement').toBe(null);
    expect(sess.stateMachine, 'cancel preserves the completed engine').toBe(completedEngine);
    expect(sess.resultGraph, 'cancel preserves the completed result').toBe(completedResult);
    expect(sess.memory.getUserQuestion(), 'cancel preserves completed memory').toBe('completed answer');
  });

  it('proposal equality ignores object key insertion order', () => {
    const summary = {
      hopCount: 1, scopeCount: 1, origin: 'o', depth: 3,
      depthIntent: { kind: 'default_start' as const }, direction: 'upstream' as const,
      analysisMode: 'bb' as const, columnAspectActive: false,
      estimatedDdlChars: 0, estimatedDdlTokens: 0, bySchema: {},
      scopeNotes: [],
      activeFilters: { schemas: [], types: [], nodeIds: [], passNodeIds: [] },
    };
    const left = {
      init: { question: 'q', origin: 'o', analysisMode: 'bb' as const, direction: 'upstream' as const },
      classification: 'business' as const,
      activeFilter: { schemas: [], types: [], hideIsolated: false, focusSchemas: [], showExternalRefs: false, externalRefTypes: [] },
      summary,
    };
    const reordered = {
      summary: {
        scopeNotes: [],
        activeFilters: { passNodeIds: [], nodeIds: [], types: [], schemas: [] },
        bySchema: {}, estimatedDdlTokens: 0, estimatedDdlChars: 0, columnAspectActive: false,
        analysisMode: 'bb' as const, direction: 'upstream' as const,
        depthIntent: { kind: 'default_start' as const }, depth: 3,
        origin: 'o', scopeCount: 1, hopCount: 1,
      },
      activeFilter: { externalRefTypes: [], showExternalRefs: false, focusSchemas: [], hideIsolated: false, types: [], schemas: [] },
      classification: 'business' as const,
      init: { direction: 'upstream' as const, analysisMode: 'bb' as const, origin: 'o', question: 'q' },
    };
    expect(sameExplorationProposal(left, reordered), 'key insertion order alone is not a proposal change').toBe(true);
    expect(!sameExplorationProposal(left, { ...reordered, init: { ...reordered.init, question: 'other' } }), 'a real content change is still detected').toBe(true);
  });

});
