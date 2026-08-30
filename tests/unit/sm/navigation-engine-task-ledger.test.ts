import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

describe("Navigation Engine Task Ledger", () => {
  const nodes: LineageNode[] = [
    makeNode({ id: 'p', schema: 'dbo', name: 'p', type: 'view' }),
    makeNode({ id: 'm', schema: 'dbo', name: 'm', type: 'view' }),
    makeNode({ id: 'x', schema: 'external', name: 'x', type: 'view' }),
  ];
  const edges: Array<[string, string]> = [['p', 'm'], ['p', 'x']];
  const model: DatabaseModel = makeModel(nodes, edges, ['dbo', 'external']);
  function snapshotTasks(engine: NavigationEngine) {
    return engine.toJSON().engineInternals.investigationTasks;
  }
  function newEngine(): NavigationEngine {
    const engine = new NavigationEngine(model, makeGraph(nodes, edges), () => {}, {
      activeFilter: { schemas: ['dbo'] } as any,
    });
    engine.init({ origin: 'p', question: 'trace the business result', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 2 } });
    return engine;
  }
  it("Different exact questions for one node remain distinct; an exact retry is idempotent.", () => {
  const engine = newEngine();
  const first = engine.getHopContext() as any;
  expect(first.focus_node?.id === 'p', 'origin is first focus').toBe(true);
  const accepted = engine.submitFindings({
    focus_node_id: 'p',
    sections: [{ angle: 'business', text: 'p analysis' }],
    summary: 'p',
    verdict: 'analyze',
    route_requests: [
      { nodeId: 'x', question: 'Where does the external result end?' },
      { nodeId: 'x', question: 'Which consumer depends on the external result?' },
      { nodeId: 'x', question: 'Where   does the external result end?' },
    ],
  });
  expect('ok' in accepted, 'scope-boundary routes commit with the accepted hop').toBe(true);
  expect(engine.pendingLeads.length === 2, 'exact normalized dedup keeps two distinct questions and removes the duplicate').toBe(true);
  expect(engine.investigationTasks.every(task => task.activeColumns === undefined), 'BB tasks never carry target columns').toBe(true);
  expect(new Set(engine.pendingLeads.map(lead => lead.id)).size === 2, 'pending leads have stable distinct ids').toBe(true);
  expect(engine.pendingLeads.every(lead => lead.reason === 'schema_boundary'), 'schema boundary is recorded mechanically').toBe(true);
});

  it("One node hop carries every distinct structured question assigned to that node.", () => {
  const engine = newEngine();
  const first = engine.getHopContext() as any;
  engine.submitFindings({
    focus_node_id: first.focus_node.id,
    sections: [{ angle: 'business', text: 'p analysis' }],
    summary: 'p',
    verdict: 'analyze',
    route_requests: [
      { nodeId: 'm', question: 'Which calculation does m apply?' },
      { nodeId: 'm', question: 'Where does m send its result?' },
    ],
  });
  const next = engine.getHopContext() as any;
  expect(next.focus_node?.id === 'm', 'the shared-question node consumes one hop').toBe(true);
  const questions = engine.getCurrentTasks().map(task => task.question);
  expect(questions.includes('Which calculation does m apply?'), 'first analytical question remains structured').toBe(true);
  expect(questions.includes('Where does m send its result?'), 'second analytical question remains structured').toBe(true);
});

  it("An explicit routed question promotes a pre-seeded node ahead of untouched BFS work.", () => {
  const engine = newEngine();
  const first = engine.getHopContext() as any;
  engine.submitFindings({
    focus_node_id: first.focus_node.id,
    sections: [{ angle: 'business', text: 'p analysis' }],
    summary: 'p',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'm', question: 'Follow the authored m branch first.' }],
  });
  const agenda = engine.toJSON().agenda;
  expect(agenda.find(entry => entry.nodeId === 'm')?.priority === 2, 'explicit route promotes an existing BFS seed to routed priority').toBe(true);
  const next = engine.getHopContext() as any;
  expect(next.focus_node?.id === 'm', 'promoted authored work dispatches before untouched equal-depth seeds').toBe(true);
});

  it("Rejected content does not leak staged leads.", () => {
  const engine = newEngine();
  const focus = engine.getHopContext() as any;
  const rejected = engine.submitFindings({
    focus_node_id: focus.focus_node.id,
    sections: [{ angle: 'business', text: 'invalid self reference' }],
    summary: 'invalid',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'x', question: 'valuable but staged' }],
    prune_neighbors: ['p'],
  });
  // The origin prune is ignored rather than a hard rejection; use a focus mismatch for a hard reject.
  const mismatch = engine.submitFindings({
    focus_node_id: 'm',
    sections: [{ angle: 'business', text: 'wrong focus' }],
    summary: 'wrong',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'x', question: 'must not persist' }],
  });
  expect('error' in mismatch, 'focus mismatch rejects atomically').toBe(true);
  expect(engine.pendingLeads.length === ('ok' in rejected ? 1 : 0), 'rejected submission creates no additional pending lead').toBe(true);
});

  it("Lead ids survive checkpointing and schedule the original question through supplement.", () => {
  const engine = newEngine();
  const first = engine.getHopContext() as any;
  engine.submitFindings({
    focus_node_id: first.focus_node.id,
    sections: [{ angle: 'business', text: 'p analysis' }],
    summary: 'p',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'x', question: 'Trace x to the end of the external branch.' }],
  });
  let next: any;
  let safety = 5;
  while (safety-- > 0) {
    next = engine.getHopContext() as any;
    if (next.done) break;
    engine.submitFindings({
      focus_node_id: next.focus_node.id,
      sections: [{ angle: 'business', text: `${next.focus_node.id} analysis` }],
      summary: next.focus_node.id,
      verdict: 'analyze',
    });
  }
  expect(next?.done === true && engine.status === 'complete', 'initial exploration completes').toBe(true);
  const leadId = engine.pendingLeads[0].id;
  const snapshot = JSON.parse(JSON.stringify(engine.toJSON()));
  const restored = NavigationEngine.fromJSON(snapshot, model, makeGraph(nodes, edges), () => {});
  expect(restored.pendingLeads[0]?.id === leadId, 'checkpoint preserves stable lead id').toBe(true);

  const invalid = restored.supplementAgenda([], ['lead_unknown']);
  expect('error' in invalid && invalid.error === 'invalid_pending_lead', 'unknown lead id rejects').toBe(true);
  expect(restored.status === 'complete', 'unknown lead rejection leaves engine state unchanged').toBe(true);

  // The lead target `x` is in the out-of-allowlist `external` schema. The follow-up pill click is the
  // user consent that widens the border: mirror followUpNode by extending the allowlist for the
  // clicked lead's schema BEFORE supplementing, so the border check passes for exactly this lead.
  const approvedSchemas = restored.resolveLeadSchemas([leadId]);
  expect(approvedSchemas.join(','), 'resolveLeadSchemas derives the lead target schema').toBe('external');
  for (const schema of approvedSchemas) restored.extendAllowedSchemas(schema);
  const scheduled = restored.supplementAgenda([], [leadId]);
  expect('ok' in scheduled && scheduled.agendaed === 1, 'valid lead schedules a supplement hop after pill-approved schema extension').toBe(true);
  const leadHop = restored.getHopContext() as any;
  expect(restored.getCurrentTasks().some(task => task.question === 'Trace x to the end of the external branch.'), 'supplement preserves the original lead question').toBe(true);
  restored.submitFindings({
    focus_node_id: leadHop.focus_node.id,
    sections: [{ angle: 'business', text: 'x analysis' }],
    summary: 'x',
    verdict: 'analyze',
  });
  restored.getHopContext();
  expect(restored.pendingLeads.length === 0, 'completed lead is not offered repeatedly').toBe(true);
  const storedLead = restored.toJSON().engineInternals?.pendingLeads?.find(lead => lead.id === leadId);
  expect(storedLead?.status === 'resolved', 'completed lead remains resolved in the audit snapshot').toBe(true);
  const repeated = restored.supplementAgenda([], [leadId]);
  expect('error' in repeated && repeated.error === 'invalid_pending_lead', 'resolved lead id cannot be scheduled again').toBe(true);
});

  it("A supplement targeting a pruned node rejects structurally and mutates nothing (zombie-lead guard).", () => {
  const engine = newEngine();
  const first = engine.getHopContext() as any;
  engine.submitFindings({
    focus_node_id: first.focus_node.id,
    sections: [{ angle: 'business', text: 'p analysis' }],
    summary: 'p',
    verdict: 'analyze',
  });
  const mHop = engine.getHopContext() as any;
  expect(mHop.focus_node?.id === 'm', 'm is dispatched as the next focus').toBe(true);
  const pruned = engine.submitFindings({
    focus_node_id: mHop.focus_node.id,
    sections: [{ angle: 'business', text: 'm is off the trace' }],
    summary: 'm',
    verdict: 'prune',
  });
  expect('ok' in pruned, 'pruning focus m commits and removes it from scope').toBe(true);
  let next: any;
  let safety = 5;
  while (safety-- > 0) {
    next = engine.getHopContext() as any;
    if (next.done) break;
    engine.submitFindings({
      focus_node_id: next.focus_node.id,
      sections: [{ angle: 'business', text: `${next.focus_node.id} analysis` }],
      summary: next.focus_node.id,
      verdict: 'analyze',
    });
  }
  expect(next?.done === true && engine.status === 'complete', 'exploration completes with m pruned').toBe(true);
  const statusBefore = engine.status;
  const leadsBefore = engine.pendingLeads.length;
  const tasksBefore = engine.getCurrentTasks().length;
  const rejected = engine.supplementAgenda(['m']);
  expect('error' in rejected && rejected.error === 'supplement_target_pruned', 'supplement targeting a pruned node rejects with the structured error').toBe(true);
  expect(engine.status === statusBefore, 'pruned-target rejection leaves engine status unchanged').toBe(true);
  expect(engine.pendingLeads.length === leadsBefore, 'pruned-target rejection creates no zombie lead').toBe(true);
  expect(engine.getCurrentTasks().length === tasksBefore, 'pruned-target rejection queues nothing').toBe(true);
});

  it("A successfully pruned focus resolves its active task instead of leaving pending ledger work.", () => {
  const engine = newEngine();
  engine.getHopContext();
  engine.submitFindings({
    focus_node_id: 'p',
    sections: [{ angle: 'business', text: 'p analysis' }],
    summary: 'p',
    verdict: 'analyze',
  });
  const mHop = engine.getHopContext() as any;
  expect(mHop.focus_node?.id === 'm', 'm is active before the prune lifecycle check').toBe(true);
  const activeIds = engine.getCurrentTasks().map(task => task.id);
  const result = engine.submitFindings({
    focus_node_id: 'm',
    sections: [{ angle: 'business', text: 'm is outside the useful chain' }],
    summary: 'm pruned',
    verdict: 'prune',
  });
  expect('ok' in result, 'valid focus prune commits').toBe(true);
  const tasks = snapshotTasks(engine);
  expect(activeIds.every(id => tasks.find(task => task.id === id)?.status === 'resolved'), 'focus prune resolves every active task').toBe(true);
});

  it("Contracted non-bodied routes never create task records with missing parents.", () => {
  const localNodes: LineageNode[] = [
    makeNode({ id: 'root', schema: 'dbo', name: 'root', type: 'procedure' }),
    makeNode({ id: 'bridge', schema: 'dbo', name: 'bridge', type: 'table' }),
    makeNode({ id: 'leaf', schema: 'dbo', name: 'leaf', type: 'view' }),
  ];
  const localEdges: Array<[string, string]> = [['root', 'bridge'], ['bridge', 'leaf']];
  const localModel: DatabaseModel = makeModel(localNodes, localEdges, ['dbo']);
  const engine = new NavigationEngine(localModel, makeGraph(localNodes, localEdges), () => {}, {});
  engine.init({ origin: 'root', question: 'trace through the bridge', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 3 } });
  const tasks = snapshotTasks(engine);
  const taskIds = new Set(tasks.map(task => task.id));
  expect(tasks.every(task => task.parentTaskId === undefined || taskIds.has(task.parentTaskId)), 'contracted seed tasks only reference parents retained in the ledger').toBe(true);
  const leafTask = tasks.find(task => task.nodeId === 'leaf');
  const rootTask = tasks.find(task => task.kind === 'root');
  expect(leafTask?.parentTaskId === rootTask?.id, 'contracted leaf remains anchored to the root task').toBe(true);
});

  it("Incomplete and internally inconsistent checkpoints fail closed instead of reconstructing state.", () => {
  const engine = newEngine();
  engine.getHopContext();
  const snapshot = JSON.parse(JSON.stringify(engine.toJSON()));
  delete snapshot.engineInternals.currentFocusTaskIds;
  let missingFieldRejected = false;
  try {
    NavigationEngine.fromJSON(snapshot, model, makeGraph(nodes, edges), () => {});
  } catch {
    missingFieldRejected = true;
  }
  expect(missingFieldRejected, 'snapshot missing currentFocusTaskIds rejects without reconstruction').toBe(true);

  const dangling = JSON.parse(JSON.stringify(engine.toJSON()));
  dangling.engineInternals.currentFocusTaskIds = ['task_missing'];
  let danglingRejected = false;
  try {
    NavigationEngine.fromJSON(dangling, model, makeGraph(nodes, edges), () => {});
  } catch {
    danglingRejected = true;
  }
  expect(danglingRejected, 'snapshot with a dangling current task reference rejects').toBe(true);

  const staleProjection = JSON.parse(JSON.stringify(engine.toJSON()));
  staleProjection.engineInternals.deferredQuestions = [];
  let unknownFieldRejected = false;
  try {
    NavigationEngine.fromJSON(staleProjection, model, makeGraph(nodes, edges), () => {});
  } catch {
    unknownFieldRejected = true;
  }
  expect(unknownFieldRejected, 'removed persisted deferredQuestions field rejects as stale state').toBe(true);

  const legacyGuardFlag = JSON.parse(JSON.stringify(engine.toJSON()));
  legacyGuardFlag.engineInternals.qualityGuards = false;
  const restoredLegacy = NavigationEngine.fromJSON(legacyGuardFlag, model, makeGraph(nodes, edges), () => {});
  expect(restoredLegacy.status === engine.status, 'legacy qualityGuards checkpoint field is accepted but runtime-dead').toBe(true);
  expect(!('qualityGuards' in restoredLegacy.toJSON().engineInternals), 'legacy qualityGuards field is not re-persisted').toBe(true);

  const unknownVersion = JSON.parse(JSON.stringify(engine.toJSON()));
  unknownVersion.snapshotVersion = 2;
  let unknownVersionRejected = false;
  try {
    NavigationEngine.fromJSON(unknownVersion, model, makeGraph(nodes, edges), () => {});
  } catch {
    unknownVersionRejected = true;
  }
  expect(unknownVersionRejected, 'unknown snapshot version rejects without migration').toBe(true);

  const unknownRootField = JSON.parse(JSON.stringify(engine.toJSON()));
  unknownRootField.compatibilityMode = true;
  let unknownRootFieldRejected = false;
  try {
    NavigationEngine.fromJSON(unknownRootField, model, makeGraph(nodes, edges), () => {});
  } catch {
    unknownRootFieldRejected = true;
  }
  expect(unknownRootFieldRejected, 'unknown snapshot field rejects at the strict boundary').toBe(true);

  const bbWithTargets = JSON.parse(JSON.stringify(engine.toJSON()));
  bbWithTargets.engineInternals.initSnapshot.targetColumns = ['amount'];
  let bbTargetRejected = false;
  try {
    NavigationEngine.fromJSON(bbWithTargets, model, makeGraph(nodes, edges), () => {});
  } catch {
    bbTargetRejected = true;
  }
  expect(bbTargetRejected, 'BB snapshot rejects target-column state').toBe(true);
});

  it("live Zod boundary and engine init already accept.", () => {
  const asymNodes: LineageNode[] = [
    makeNode({ id: 'up2', schema: 'dbo', name: 'up2', type: 'view' }),
    makeNode({ id: 'up1', schema: 'dbo', name: 'up1', type: 'view' }),
    makeNode({ id: 'checkpoint_origin', schema: 'dbo', name: 'checkpoint_origin', type: 'procedure' }),
    makeNode({ id: 'down1', schema: 'dbo', name: 'down1', type: 'view' }),
  ];
  const asymEdges: Array<[string, string]> = [
    ['up2', 'up1'],
    ['up1', 'checkpoint_origin'],
    ['checkpoint_origin', 'down1'],
  ];
  const asymModel: DatabaseModel = makeModel(asymNodes, asymEdges, ['dbo']);
  const asymGraph = makeGraph(asymNodes, asymEdges);
  const engine = new NavigationEngine(asymModel, asymGraph, () => {}, {});
  engine.init({
    origin: 'checkpoint_origin',
    question: 'trace upstream only, two levels',
    depthIntent: { kind: 'asymmetric', upstream: 2, downstream: 0 },
  });
  engine.getHopContext();

  const snapshot = JSON.parse(JSON.stringify(engine.toJSON()));
  expect(snapshot.engineInternals.initSnapshot.depthIntent.upstream, 'checkpoint persists the upstream side verbatim').toBe(2);
  expect(snapshot.engineInternals.initSnapshot.depthIntent.downstream, 'checkpoint persists the downstream 0 side verbatim').toBe(0);

  const restored = NavigationEngine.fromJSON(snapshot, asymModel, makeGraph(asymNodes, asymEdges), () => {});
  const restoredResult = restored.getResult();
  const restoredScopeIds = new Set(restoredResult.fullNodes.map(n => n.id));
  expect(restoredScopeIds.has('up1') && restoredScopeIds.has('up2'), 'restored engine retains the upstream scope seeded before the 0-side checkpoint').toBe(true);
  expect(!restoredScopeIds.has('down1'), 'restored engine still excludes the suppressed downstream side').toBe(true);

  // Both sides 0 is rejected by the checkpoint boundary too — mirrors the live Zod contract.
  const bothZeroSnapshot = JSON.parse(JSON.stringify(engine.toJSON()));
  bothZeroSnapshot.engineInternals.initSnapshot.depthIntent = { kind: 'asymmetric', upstream: 0, downstream: 0 };
  let bothZeroCheckpointRejected = false;
  try {
    NavigationEngine.fromJSON(bothZeroSnapshot, asymModel, makeGraph(asymNodes, asymEdges), () => {});
  } catch {
    bothZeroCheckpointRejected = true;
  }
  expect(bothZeroCheckpointRejected, 'checkpoint with both depth sides 0 rejects at restore, mirroring the live schema boundary').toBe(true);
});

  it("Deferred-question synthesis output is derived from unresolved boundary leads only.", () => {
  const engine = newEngine();
  const first = engine.getHopContext() as any;
  engine.submitFindings({
    focus_node_id: first.focus_node.id,
    sections: [{ angle: 'business', text: 'p analysis' }],
    summary: 'p',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'x', question: 'Trace the external branch later.' }],
  });
  const lead = engine.pendingLeads[0];
  const deferred = engine.deferredQuestions;
  expect(deferred.length === 1 && deferred[0].question === 'Trace the external branch later.', 'deferred question projects the typed boundary task question').toBe(true);
  expect(deferred[0].nodeId === lead.nodeId && deferred[0].fromFocusNodeId === lead.fromNodeId, 'deferred projection retains lead route identity').toBe(true);
});

  it("BB enqueue tolerates an explicit empty columns array (normalized to omitted, no throw).", () => {
  const engine = newEngine();
  let threw = false;
  try {
    (engine as any).enqueueHop('m', 'probe m', 1, 2, []);
  } catch {
    threw = true;
  }
  expect(!threw, 'BB enqueueHop normalizes an empty columns array instead of throwing').toBe(true);
});

});
