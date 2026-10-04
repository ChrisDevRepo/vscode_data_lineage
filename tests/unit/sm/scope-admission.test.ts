/**
 * The one exploration admission check at start_exploration: round-bearing objects against
 * `ai.maxRounds` (tables take no round) and a trace's starting columns against `ai.maxTraceColumns`; the node count never refuses. A refusal is a control result carrying the user's text —
 * no proposal is stored, no card, and a held proposal survives a refused refinement.
 */
import { executeStartExploration } from '../../../src/ai/tools/handlers/startExploration';
import { createTurnTokenBudget } from '../../../src/ai/support/tokenBudget';
import type { LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../../../tests/unit/helpers/testUtils';
import { makeModel, makeNode } from '../../../tests/unit/sm/helpers/fixtures';
import { stubToolServices } from './helpers/toolServices';
import { describe, expect, it } from 'vitest';

const DEPTH = { upstream: { levels: 3, exactness: 'approximate' }, downstream: { levels: 3, exactness: 'approximate' } };

/** An origin procedure with `procs` further procedures and `tables` tables one edge away. */
function starScope(procs: number, tables: number, sqlOf: (id: string) => string | undefined = () => undefined) {
  const nodes: LineageNode[] = [makeNode({ id: 'origin', schema: 'dbo', name: 'origin', type: 'procedure' })];
  const edges: Array<[string, string]> = [];
  for (let i = 0; i < procs; i++) {
    const id = `p${i}`;
    nodes.push(makeNode({ id, schema: 'dbo', name: id, type: 'procedure', bodyScript: sqlOf(id) }));
    edges.push(['origin', id]);
  }
  for (let i = 0; i < tables; i++) {
    const id = `t${i}`;
    nodes.push(makeNode({ id, schema: 'dbo', name: id, type: 'table' }));
    edges.push(['origin', id]);
  }
  return { model: makeModel(nodes, edges, ['dbo']), graph: makeGraph(nodes, edges) };
}

function newSession(): Record<string, unknown> {
  const session: Record<string, unknown> = {
    id: 'sess-admission',
    stateMachine: null,
    pendingExploration: null,
    phase: { kind: 'idle' },
    currentRoundId: 1,
    startExplorationRoundId: null,
    currentTurnPrompt: 'trace',
    pendingUserNotice: new Set<string>(),
    storePendingExploration(proposal: Record<string, unknown>) {
      session.pendingExploration = { ...proposal, revision: 1 };
      return { kind: 'accepted' };
    },
  };
  return session;
}

async function start(
  scope: ReturnType<typeof starScope>,
  budget: ReturnType<typeof createTurnTokenBudget>,
  textModel?: unknown,
  session = newSession(),
) {
  const { services, getReturned } = stubToolServices({ session, ...scope, budget, textModel });
  await executeStartExploration({
    origin: 'origin', analysisMode: 'bb', question: 'trace', classification: 'both', depth: DEPTH,
  }, services);
  return { returned: getReturned(), session };
}

describe('admission axes', () => {
  it('refuses 11 round-bearing objects at maxRounds 5 with the user text, no proposal, no card', async () => {
    const { returned, session } = await start(starScope(10, 0), createTurnTokenBudget({ maxRounds: 5 }));
    expect(returned.code).toBe('over_active_scope_budget');
    expect(returned.reason).toContain('round limit reached (11/5)');
    expect(returned.reason).toContain('dataLineageViz.ai.maxRounds');
    expect((returned.detail as { gate?: string } | undefined)?.gate).toBeUndefined();
    expect(session.pendingExploration).toBeNull();
  });

  it('admits 30 tables and 10 procedures at maxRounds 50: tables take no round', async () => {
    const { returned, session } = await start(starScope(9, 30), createTurnTokenBudget({ maxRounds: 50 }));
    expect(returned.code, JSON.stringify(returned)).toBe('action_required');
    expect(session.pendingExploration).not.toBeNull();
  });

  it('uses the maxRounds of the budget it is handed: changed between two turns', async () => {
    const scope = starScope(10, 0);
    expect((await start(scope, createTurnTokenBudget({ maxRounds: 5 }))).returned.code).toBe('over_active_scope_budget');
    expect((await start(scope, createTurnTokenBudget({ maxRounds: 20 }))).returned.code).toBe('action_required');
  });

  it('admits 200 tables at maxRounds 5: the node count never refuses', async () => {
    const { returned, session } = await start(starScope(0, 200), createTurnTokenBudget({ maxRounds: 5 }));
    expect(returned.code, JSON.stringify(returned)).toBe('action_required');
    expect(session.pendingExploration).not.toBeNull();
  });

  it('a refused refinement says the change was not applied and leaves the held proposal', async () => {
    const scope = starScope(10, 0);
    const session = newSession();
    const held = { revision: 1, init: { origin: 'origin' } };
    session.pendingExploration = held;
    session.phase = { kind: 'awaiting_gate' };
    const { services, getReturned } = stubToolServices({ session, ...scope, budget: createTurnTokenBudget({ maxRounds: 5 }) });
    await executeStartExploration({ proposalRevision: 1, origin: 'origin', analysisMode: 'bb', classification: 'both', depth: DEPTH }, services);
    expect(getReturned().reason).toContain('The change was not applied: round limit reached (11/5)');
    expect(session.pendingExploration).toBe(held);
  });
});

/** A view origin exposing `n` columns c0..c(n-1), one view downstream. */
function columnScope(n: number) {
  const columns = Array.from({ length: n }, (_, i) => ({ name: `c${i}`, type: 'int', nullable: 'NOT NULL', extra: '' }));
  const nodes: LineageNode[] = [
    makeNode({ id: 'origin', schema: 'dbo', name: 'origin', type: 'view', columns }),
    makeNode({ id: 'child', schema: 'dbo', name: 'child', type: 'view', columns }),
  ];
  const edges: Array<[string, string]> = [['origin', 'child']];
  return { model: makeModel(nodes, edges, ['dbo']), graph: makeGraph(nodes, edges), names: columns.map(c => c.name) };
}

describe('trace column limit', () => {
  const ct = (names: string[]) => ({ analysisMode: 'ct' as const, targetColumns: names });

  it('refuses 11 starting columns at maxTraceColumns 10 naming the setting, no proposal, no card', async () => {
    const scope = columnScope(11);
    const session = newSession();
    const { services, getReturned } = stubToolServices({ session, ...scope, budget: createTurnTokenBudget({ maxTraceColumns: 10 }) });
    await executeStartExploration({ origin: 'origin', question: 'trace', classification: 'both', depth: DEPTH, ...ct(scope.names) }, services);
    const returned = getReturned();
    expect(returned.code).toBe('over_active_scope_budget');
    expect(returned.reason).toContain('column limit reached (11/10)');
    expect(returned.reason).toContain('dataLineageViz.ai.maxTraceColumns');
    expect((returned.detail as { gate?: string } | undefined)?.gate).toBeUndefined();
    expect(session.pendingExploration).toBeNull();
  });

  it('admits 10 starting columns at maxTraceColumns 10', async () => {
    const scope = columnScope(10);
    const session = newSession();
    const { services, getReturned } = stubToolServices({ session, ...scope, budget: createTurnTokenBudget({ maxTraceColumns: 10 }) });
    await executeStartExploration({ origin: 'origin', question: 'trace', classification: 'both', depth: DEPTH, ...ct(scope.names) }, services);
    expect(getReturned().code, JSON.stringify(getReturned())).toBe('action_required');
    expect(session.pendingExploration).not.toBeNull();
  });

  it('a BB scope is never refused on columns', async () => {
    const { returned } = await start(starScope(0, 2), createTurnTokenBudget({ maxTraceColumns: 1 }));
    expect(returned.code, JSON.stringify(returned)).toBe('action_required');
  });

  it('a refine that raises the starting columns over the limit says the change was not applied and keeps the held proposal', async () => {
    const scope = columnScope(11);
    const session = newSession();
    const held = { revision: 1, init: { origin: 'origin' } };
    session.pendingExploration = held;
    session.phase = { kind: 'awaiting_gate' };
    const { services, getReturned } = stubToolServices({ session, ...scope, budget: createTurnTokenBudget({ maxTraceColumns: 10 }) });
    await executeStartExploration({ proposalRevision: 1, origin: 'origin', classification: 'both', depth: DEPTH, ...ct(scope.names) }, services);
    expect(getReturned().reason).toContain('The change was not applied: column limit reached (11/10)');
    expect(session.pendingExploration).toBe(held);
  });
});
