/**
 * Turn-lease enforcement inside the `lineage_present_result` handler.
 *
 * @remarks
 * The handler holds two independent stale-turn exits: the attempt guard at entry, and the commit
 * guard after assembly. Both are reachable only when the session's turn epoch moves past the epoch
 * the handler captured, so these tests drive the epoch directly through {@link AiSession.beginTurn}
 * rather than through the runtime. Everything else the handler touches arrives through the
 * {@link ToolServices} seam, which is faked here in full.
 */
import { describe, expect, it } from 'vitest';
import { AiSession } from '../../../src/ai/session/session';
import { executePresentResult } from '../../../src/ai/tools/handlers/presentResult';
import type { ToolServices } from '../../../src/ai/tools/handlers/toolServices';
import type { ResultGraph } from '../../../src/ai/session/types';
import type { DatabaseModel } from '../../../src/engine/types';
import type { Logger } from '../../../src/utils/log';

const ORIGIN_NODE = '[dbo].[Orders]';

/** Minimal payload that clears the boundary schema and full presentation validation. */
function validPresentResultInput(): Record<string, unknown> {
  return {
    name: 'Orders Lineage',
    summary: 'How Orders is populated.',
    sections: [{ label: 'Source', node_ids: [ORIGIN_NODE], text: 'Orders is the sole source table.' }],
    highlight_groups: [{ label: 'Flow', color: 'source', node_ids: [ORIGIN_NODE] }],
    notes: [{ node_id: ORIGIN_NODE, text: 'Orders is the sole source table.' }],
  };
}

function seedResultGraph(session: AiSession): ResultGraph {
  const resultGraph: ResultGraph = {
    nodeIds: [ORIGIN_NODE],
    edges: [],
    source: 'blackboard',
  };
  session.resultGraph = resultGraph;
  return resultGraph;
}

const SILENT_LOGGER = {
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
} as unknown as Logger;

const TEST_MODEL = {
  nodes: [{ id: ORIGIN_NODE, name: 'Orders', schema: 'dbo', type: 'table' }],
  edges: [],
} as unknown as DatabaseModel;

interface HandlerProbe {
  readonly services: ToolServices;
  readonly logged: Array<{ toolName: string; data: object }>;
  panelReads: number;
  modelReads: number;
}

/**
 * Builds a full {@link ToolServices} double.
 *
 * @param session - Session the handler reads and writes.
 * @param capturedEpoch - Epoch the handler captures at entry (the turn's lease).
 * @param onPanelRead - Hook fired at the handler's panel lookup, the last seam before the commit guard.
 */
function handlerProbe(
  session: AiSession,
  capturedEpoch: number,
  onPanelRead?: () => void,
  panel?: unknown,
): HandlerProbe {
  const logged: Array<{ toolName: string; data: object }> = [];
  const probe: HandlerProbe = {
    logged,
    panelReads: 0,
    modelReads: 0,
    services: {
      getSession: () => session,
      getPanel: () => {
        probe.panelReads += 1;
        onPanelRead?.();
        return panel as never;
      },
      logger: SILENT_LOGGER,
      turnEpoch: () => capturedEpoch,
      requireModel: () => {
        probe.modelReads += 1;
        return TEST_MODEL;
      },
      requireGraph: () => { throw new Error('requireGraph is not part of the present_result path'); },
      logAndReturn: (toolName, data) => {
        logged.push({ toolName, data });
        return JSON.stringify(data);
      },
      buildActiveFilter: () => { throw new Error('buildActiveFilter is not part of the present_result path'); },
      toolError: (toolName, err) => JSON.stringify({ error: 'internal_error', tool: toolName, message: String(err) }),
    },
  };
  return probe;
}

function parseResult(raw: string): Record<string, unknown> {
  return JSON.parse(raw) as Record<string, unknown>;
}

function seedPreviewSource(session: AiSession, epoch: number): void {
  session.lastDiscoveryAnswer = '# Orders Lineage\n\nOrders is the sole source table.';
  session.lastDiscoveryQuestion = 'What feeds Orders?';
  session.discoveryScopeArtifact = {
    turnEpoch: epoch,
    origin: ORIGIN_NODE,
    direction: 'bidirectional',
    nodeIds: [ORIGIN_NODE],
    edges: [],
  };
}

describe('executePresentResult — turn-lease enforcement', () => {
  it('commits a bounded discovery scope through the shared presentation path', async () => {
    const session = new AiSession();
    const epoch = session.beginTurn();
    session.activeLmStage = { kind: 'visual_preview' };
    seedPreviewSource(session, epoch);
    const probe = handlerProbe(session, epoch);

    const result = parseResult(await executePresentResult(validPresentResultInput(), probe.services));

    expect(result.success).toBe(true);
    expect(result.graph_source).toBe('discovery_preview');
    expect(session.stateMachine).toBeNull();
    expect(session.resultGraph).toMatchObject({
      nodeIds: [ORIGIN_NODE],
      source: 'discovery_preview',
      originNodeId: ORIGIN_NODE,
      summary: 'Orders is the sole source table.',
    });
    expect(session.lastPresentResultDescription).toContain('## 1 Source');
  });

  it('keeps graph edits forbidden for a bounded preview even from a completed session', async () => {
    const session = new AiSession();
    const epoch = session.beginTurn();
    session.enterCompleted(epoch);
    session.activeLmStage = { kind: 'visual_preview' };
    seedPreviewSource(session, epoch);
    const probe = handlerProbe(session, epoch);

    const result = parseResult(await executePresentResult({
      ...validPresentResultInput(),
      add_node_ids: ['[dbo].[Other]'],
    }, probe.services));

    expect(result.error).toBe('invalid_input');
    expect(result.hint).toMatch(/strictly forbidden/);
    expect(session.resultGraph).toBeNull();
  });

  it('repairs only rewritten preview sections while retaining accepted decoration', async () => {
    const session = new AiSession();
    const epoch = session.beginTurn();
    session.activeLmStage = { kind: 'visual_preview' };
    seedPreviewSource(session, epoch);
    const probe = handlerProbe(session, epoch);

    const rejected = parseResult(await executePresentResult({
      ...validPresentResultInput(),
      sections: [{ label: 'Source', node_ids: [ORIGIN_NODE], text: 'A rewritten summary.' }],
    }, probe.services));
    expect(rejected.success).toBe(false);
    expect(session.presentResultRepairDraft.getAuthorization()).toEqual(['sections']);

    const repaired = parseResult(await executePresentResult({
      sections: [{ label: 'Source', node_ids: [ORIGIN_NODE], text: 'Orders is the sole source table.' }],
    }, probe.services));
    expect(repaired.success).toBe(true);
    expect(session.lastPresentResultHighlightGroups).toEqual([
      { label: 'Flow', color: 'source', nodeIds: [ORIGIN_NODE] },
    ]);
  });

  it('commits normally while the captured turn still owns the session', async () => {
    const session = new AiSession();
    const resultGraph = seedResultGraph(session);
    const epoch = session.beginTurn();
    const probe = handlerProbe(session, epoch);

    const result = parseResult(await executePresentResult(validPresentResultInput(), probe.services));

    expect(result.success).toBe(true);
    expect(result.view_name).toBe('Orders Lineage');
    expect(session.presentResultCalledThisTurn).toBe(true);
    expect(session.lastPresentResultSummary).toBe('How Orders is populated.');
    expect(resultGraph.summary).toBe('How Orders is populated.');
  });

  it('marks a result auto-dispatched only after the webview accepts it', async () => {
    const session = new AiSession();
    seedResultGraph(session);
    const epoch = session.beginTurn();
    const sent: unknown[] = [];
    const panel = {
      webview: { postMessage: (message: unknown) => { sent.push(message); return Promise.resolve(true); } },
      reveal: () => undefined,
    };
    const probe = handlerProbe(session, epoch, undefined, panel);

    const result = parseResult(await executePresentResult(validPresentResultInput(), probe.services));

    expect(result.success).toBe(true);
    expect(sent).toHaveLength(1);
    expect(session.presentResultAutoDispatched).toBe(true);
  });

  it('returns stale_turn and touches nothing when the entry guard rejects the captured epoch', async () => {
    const session = new AiSession();
    const resultGraph = seedResultGraph(session);
    const staleEpoch = session.beginTurn();
    // A superseding turn takes ownership before the tool call lands.
    session.beginTurn();
    const graphBefore = JSON.stringify(resultGraph);
    const probe = handlerProbe(session, staleEpoch);

    const result = parseResult(await executePresentResult(validPresentResultInput(), probe.services));

    expect(result).toEqual({
      error: 'stale_turn',
      hint: 'The turn no longer owns this session. Do not render this result.',
    });

    // No panel post: the handler never even reaches the panel lookup.
    expect(probe.panelReads).toBe(0);
    // No model read: assembly never starts.
    expect(probe.modelReads).toBe(0);
    // No session mutation: counters, presentation state, and the result graph are untouched.
    expect(session.presentResultAttemptCountThisTurn).toBe(0);
    expect(session.presentResultFailureCountThisTurn).toBe(0);
    expect(session.presentResultCalledThisTurn).toBe(false);
    expect(session.presentResultLastFailureReasonThisTurn).toBeNull();
    expect(session.lastPresentResultSummary).toBeNull();
    expect(session.lastPresentResultDescription).toBeNull();
    expect(session.lastPresentResultHighlightGroups).toBeNull();
    expect(session.presentResultRepairDraft.hasRepairableDraft()).toBe(false);
    expect(JSON.stringify(resultGraph)).toBe(graphBefore);
    expect(probe.logged.map((entry) => entry.toolName)).toEqual(['present_result']);
  });

  it('returns stale_turn from the commit guard when the turn is superseded mid-handler', async () => {
    const session = new AiSession();
    const resultGraph = seedResultGraph(session);
    const epoch = session.beginTurn();
    const graphBefore = JSON.stringify(resultGraph);
    // The panel lookup is the last seam before the commit guard; advancing the epoch there
    // reproduces a turn superseded after assembly but before the presentation commit.
    const probe = handlerProbe(session, epoch, () => { session.beginTurn(); });

    const result = parseResult(await executePresentResult(validPresentResultInput(), probe.services));

    expect(result).toEqual({
      error: 'stale_turn',
      hint: 'The result was not committed because the turn no longer owns this session.',
    });
    expect(probe.panelReads).toBe(1);
    // The guarded presentation commit is dropped: no success is recorded for the superseding turn.
    expect(session.presentResultCalledThisTurn).toBe(false);
    expect(session.lastPresentResultSummary).toBeNull();
    expect(session.lastPresentResultDescription).toBeNull();
    expect(session.lastPresentResultHighlightGroups).toBeNull();

    // The stale turn's graph writes are staged behind the accepted commit, so a rejected commit
    // leaves the owning turn's live resultGraph completely untouched.
    expect(JSON.stringify(resultGraph)).toBe(graphBefore);
    expect(resultGraph.summary).toBeUndefined();
    expect(resultGraph.notes).toBeUndefined();
  });

  it('drops a stale-epoch failure note instead of charging the superseding turn', async () => {
    const session = new AiSession();
    seedResultGraph(session);
    const staleEpoch = session.beginTurn();
    session.beginTurn();
    const probe = handlerProbe(session, staleEpoch);

    // A structurally invalid payload would normally record a present_result failure; under a stale
    // lease the handler exits at the entry guard, so the superseding turn is never charged.
    const result = parseResult(await executePresentResult({ summary: 'missing name' }, probe.services));

    expect(result.error).toBe('stale_turn');
    expect(session.presentResultFailureCountThisTurn).toBe(0);
    expect(session.presentResultLastFailureReasonThisTurn).toBeNull();
  });
});
