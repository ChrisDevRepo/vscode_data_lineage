import { assert, assertEq } from '../helpers/testUtils';
import { AiSession, sameExplorationProposal } from '../../../src/ai/session/session';
import type { SmResult } from '../../../src/ai/sm/smTypes';
import { describe, it } from 'vitest';

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
    assertEq(accepted.kind, 'accepted', 'fresh-token enterExploring is accepted');
    assertEq(sess.phase.kind, 'exploring', 'phase advanced to exploring');

    // A later turn supersedes t1 without any explicit reset.
    const t2 = sess.beginTurn();
    assert(t2 !== t1, 'beginTurn bumps the epoch (t2 != t1)');

    const stale = sess.enterIdle(t1);
    assertEq(stale.kind, 'dropped_stale_turn', 'stale-token enterIdle is dropped');
    if (stale.kind === 'dropped_stale_turn') {
      assertEq(stale.op, 'enterIdle', 'drop names the op');
      assertEq(stale.captured, t1, 'drop reports the captured (stale) epoch');
      assertEq(stale.current, t2, 'drop reports the current live epoch');
    }
    assertEq(sess.phase.kind, 'exploring', 'phase is unchanged after a dropped stale write');

    // The live turn's own write still lands.
    const fresh = sess.enterIdle(t2);
    assertEq(fresh.kind, 'accepted', 'fresh-token enterIdle is accepted');
    assertEq(sess.phase.kind, 'idle', 'phase advanced to idle on the accepted write');
  });

  it("storeSmResult epoch guard", () => {
    const sess = new AiSession();
    const t1 = sess.beginTurn();
    const t2 = sess.beginTurn(); // supersede t1 before the stale write

    const stale = sess.storeSmResult(sampleResult, t1);
    assertEq(stale.kind, 'dropped_stale_turn', 'stale-token storeSmResult is dropped');
    assertEq(sess.resultGraph, null, 'resultGraph is untouched by a dropped stale write');

    const fresh = sess.storeSmResult(sampleResult, t2);
    assertEq(fresh.kind, 'accepted', 'fresh-token storeSmResult is accepted');
    assert(sess.resultGraph !== null, 'resultGraph is populated by the accepted write');
    assertEq(sess.resultGraph?.originNodeId, 'origin', 'resultGraph carries the result origin');
  });

  it("diagnostics-write epoch guard", () => {
    const sess = new AiSession();
    const t1 = sess.beginTurn();

    // Fresh-token diagnostics writes land.
    const hopOk = sess.setHopCount(t1, 3);
    assertEq(hopOk.kind, 'accepted', 'fresh-token setHopCount is accepted');
    assertEq(sess.hopCount, 3, 'hopCount updated by the accepted write');

    const evtOk = sess.recordMemoryWipeEvent(t1, { kind: 'sliding', trigger: 'submit_ok', hop: 3, messagesBefore: 7 });
    assertEq(evtOk.kind, 'accepted', 'fresh-token recordMemoryWipeEvent is accepted');
    assertEq(sess.memoryWipeEventsThisTurn.length, 1, 'wipe event appended by the accepted write');

    // A later turn supersedes t1; the stale writes must be dropped no-ops.
    const t2 = sess.beginTurn();

    const hopStale = sess.setHopCount(t1, 99);
    assertEq(hopStale.kind, 'dropped_stale_turn', 'stale-token setHopCount is dropped');
    if (hopStale.kind === 'dropped_stale_turn') {
      assertEq(hopStale.op, 'setHopCount', 'drop names the setHopCount op');
      assertEq(hopStale.current, t2, 'drop reports the current live epoch');
    }
    assertEq(sess.hopCount, 3, 'hopCount untouched by a dropped stale write');

    const evtStale = sess.recordMemoryWipeEvent(t1, { kind: 'sliding', trigger: 'stale', hop: 99, messagesBefore: 12 });
    assertEq(evtStale.kind, 'dropped_stale_turn', 'stale-token recordMemoryWipeEvent is dropped');
    if (evtStale.kind === 'dropped_stale_turn') {
      assertEq(evtStale.op, 'recordMemoryWipeEvent', 'drop names the recordMemoryWipeEvent op');
    }
    assertEq(sess.memoryWipeEventsThisTurn.length, 1, 'wipe events untouched by a dropped stale write');

    // The live turn's own writes still land.
    assertEq(sess.setHopCount(t2, 5).kind, 'accepted', 'fresh-token setHopCount (t2) is accepted');
    assertEq(sess.hopCount, 5, 'hopCount advanced on the accepted t2 write');
    assertEq(sess.recordMemoryWipeEvent(t2, { kind: 'sliding', trigger: 'submit_ok', hop: 5, messagesBefore: 4 }).kind, 'accepted', 'fresh-token recordMemoryWipeEvent (t2) is accepted');
    assertEq(sess.memoryWipeEventsThisTurn.length, 2, 'wipe event appended on the accepted t2 write');
  });

  it("resetExploration internal path", () => {
    const sess = new AiSession();
    const t1 = sess.beginTurn();
    sess.enterExploring(t1);
    assertEq(sess.phase.kind, 'exploring', 'precondition: exploring');

    const epochBefore = sess.turnEpoch;
    sess.resetExploration();
    assertEq(sess.phase.kind, 'idle', 'resetExploration returns to idle via its internal enterIdle');
    assertEq(sess.turnEpoch, epochBefore, 'resetExploration does NOT bump the epoch');
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

    assertEq(sess.storePendingExploration(proposal, token).kind, 'accepted', 'fresh proposal is stored');
    assertEq(sess.pendingExploration?.revision, 1, 'first proposal receives revision 1');
    assertEq(sess.stateMachine, null, 'proposal preview does not publish an engine before approval');
    assertEq(sess.classification, undefined, 'proposal preview does not lock classification before approval');
    assertEq(sess.phase.kind, 'idle', 'proposal storage alone does not enter exploring');

    let staleFactoryCalled = false;
    const stale = sess.activatePendingExploration(99, token, () => {
      staleFactoryCalled = true;
      return {} as any;
    });
    assertEq(stale.kind, 'rejected', 'stale proposal revision is rejected');
    assert(!staleFactoryCalled, 'stale revision is rejected before engine construction');
    assertEq(sess.stateMachine, null, 'stale approval leaves active engine untouched');
    assertEq(sess.pendingExploration?.revision, 1, 'stale approval preserves the reviewable proposal');

    const failed = sess.activatePendingExploration(1, token, () => ({ error: 'init_failed' }));
    assertEq(failed.kind, 'rejected', 'failed engine initialization rejects activation');
    assertEq(sess.stateMachine, null, 'failed activation publishes no partial engine');
    assertEq(sess.pendingExploration?.revision, 1, 'failed activation preserves the proposal for review/retry');
    assertEq(sess.memory.getUserQuestion(), 'completed question must survive review', 'failed activation leaves stable session memory unchanged');

    const publishFailed = sess.activatePendingExploration(1, token, () => ({
      status: 'initialized',
      publishMemoryTo(target: AiSession['memory']) {
        target.setUserQuestion('partial publish');
        throw new Error('publish_failed');
      },
    } as any));
    assertEq(publishFailed.kind, 'rejected', 'memory publication failure rejects activation');
    assertEq(sess.stateMachine, null, 'memory publication failure publishes no engine');
    assertEq(sess.pendingExploration?.revision, 1, 'memory publication failure preserves the proposal');
    assertEq(sess.memory.getUserQuestion(), 'completed question must survive review', 'memory publication failure rolls back session memory');

    const approvedEngine = {
      status: 'initialized',
      publishMemoryTo(target: AiSession['memory']) {
        target.reset();
        target.setUserQuestion('new approved question');
      },
    } as any;
    const approved = sess.activatePendingExploration(1, token, (reviewed) => {
      assertEq(reviewed.init.depthIntent?.kind, 'asymmetric', 'factory receives the exact reviewed depth intent');
      return approvedEngine;
    });
    assertEq(approved.kind, 'accepted', 'matching proposal revision activates');
    assertEq(sess.stateMachine, approvedEngine, 'approved engine is published atomically');
    assertEq(sess.pendingExploration, null, 'approved proposal is consumed');
    assertEq(sess.classification, 'technical', 'approved classification becomes active');
    assertEq(sess.phase.kind, 'exploring', 'successful activation enters exploring');
    assertEq(sess.memory.getUserQuestion(), 'new approved question', 'validated engine memory publishes only at approval');
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
    assert(sameExplorationProposal(proposal, sess.pendingExploration!), 'revision is ignored when detecting a no-op refine');
    sess.enterGate({ gate: 'confirm_sm_start', classes: [], nodeIds: [], detail: 'replacement', proposalRevision: 1 }, token);
    assertEq(sess.stateMachine, completedEngine, 'completed engine remains published during proposal review');
    assertEq(sess.resultGraph, completedResult, 'completed result remains published during proposal review');
    assertEq(sess.memory.getUserQuestion(), 'completed answer', 'completed memory remains intact during proposal review');

    const cancelled = sess.cancelPendingExploration(token);
    assertEq(cancelled.kind, 'accepted', 'proposal cancel is accepted for the owning turn');
    assertEq(sess.phase.kind, 'completed', 'cancel returns to the preserved completed phase');
    assertEq(sess.pendingExploration, null, 'cancel clears only the pending replacement');
    assertEq(sess.stateMachine, completedEngine, 'cancel preserves the completed engine');
    assertEq(sess.resultGraph, completedResult, 'cancel preserves the completed result');
    assertEq(sess.memory.getUserQuestion(), 'completed answer', 'cancel preserves completed memory');
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
    assert(sameExplorationProposal(left, reordered), 'key insertion order alone is not a proposal change');
    assert(
      !sameExplorationProposal(left, { ...reordered, init: { ...reordered.init, question: 'other' } }),
      'a real content change is still detected',
    );
  });

});
