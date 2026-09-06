/**
 * `lineage_present_result` dispatch contract: the stage schema decides, and every rewrite is logged.
 *
 * @remarks
 * Two invariants of the same handler, driven through the {@link ToolServices} seam:
 *
 * - A field the stage's offered schema omits (`presentResultSchemaForPhase`) is rejected by the
 *   boundary parse, with the offender's path riding in `detail` where `rejectionIssuePaths` reads
 *   it — not by a hand-written check after a permissive parse.
 * - Node-id canonicalisation is normalize-with-log, the contract `submit_findings` already holds:
 *   a changed value emits one `[Normalize] tool=present_result field=… from=… to=…` line, an
 *   unchanged value emits none.
 */
import { describe, expect, it } from 'vitest';
import { AiSession } from '../../../src/ai/session/session';
import { executePresentResult } from '../../../src/ai/tools/handlers/presentResult';
import { rejectionIssuePaths } from '../../../src/ai/support/toolErrorEnvelope';
import type { ToolServices } from '../../../src/ai/tools/handlers/toolServices';
import type { ResultGraph } from '../../../src/ai/session/types';
import type { DatabaseModel } from '../../../src/engine/types';
import type { Logger } from '../../../src/utils/log';

const ORIGIN_NODE = '[dbo].[Orders]';

const TEST_MODEL = {
  nodes: [{ id: ORIGIN_NODE, name: 'Orders', schema: 'dbo', type: 'table' }],
  edges: [],
} as unknown as DatabaseModel;

interface Probe {
  readonly services: ToolServices;
  readonly debugLines: string[];
}

/** Builds a {@link ToolServices} double that records every debug line the handler emits. */
function handlerProbe(session: AiSession, capturedEpoch: number): Probe {
  const debugLines: string[] = [];
  const logger = {
    debug: (message: string): void => { debugLines.push(message); },
    info: (): void => undefined,
    warn: (): void => undefined,
    error: (): void => undefined,
  } as unknown as Logger;
  return {
    debugLines,
    services: {
      getSession: () => session,
      getPanel: () => undefined as never,
      logger,
      maxRounds: 50,
      turnEpoch: () => capturedEpoch,
      requireModel: () => TEST_MODEL,
      requireGraph: () => { throw new Error('requireGraph is not part of the present_result path'); },
      logAndReturn: (_toolName, data) => JSON.stringify(data),
      buildActiveFilter: () => { throw new Error('buildActiveFilter is not part of the present_result path'); },
      toolError: (toolName, err) => JSON.stringify({ error: 'internal_error', tool: toolName, message: String(err) }),
    },
  };
}

/** Seeds a committed single-node result graph so the render path has a graph to validate against. */
function seedResultGraph(session: AiSession): ResultGraph {
  const resultGraph: ResultGraph = { nodeIds: [ORIGIN_NODE], edges: [], source: 'blackboard' };
  session.resultGraph = resultGraph;
  return resultGraph;
}

/** Minimal payload that clears the boundary schema and full presentation validation. */
function validPayload(nodeId: string = ORIGIN_NODE): Record<string, unknown> {
  return {
    name: 'Orders Lineage',
    summary: 'How Orders is populated.',
    sections: [{ label: 'Source', node_ids: [nodeId], text: 'Orders is the sole source table.' }],
    highlight_groups: [{ label: 'Flow', color: 'source', node_ids: [nodeId] }],
    notes: [{ node_id: nodeId, text: 'Orders is the sole source table.' }],
  };
}

function parseResult(raw: string): Record<string, unknown> {
  return JSON.parse(raw) as Record<string, unknown>;
}

const NORMALIZE_LINES = (lines: readonly string[]): string[] =>
  lines.filter(line => line.startsWith('[Normalize] tool=present_result'));

describe('present_result — the stage schema is the dispatch contract', () => {
  it('rejects add_node_ids on a synthesis render through the schema, naming the field in issuePaths', async () => {
    const session = new AiSession();
    const epoch = session.beginTurn();
    seedResultGraph(session);
    const probe = handlerProbe(session, epoch);

    const result = parseResult(await executePresentResult({
      ...validPayload(),
      add_node_ids: ['[dbo].[Other]'],
    }, probe.services));

    expect(result.success, 'a field the synthesis schema omits is rejected').toBe(false);
    expect(String((result.errors as string[])[0]), 'the reason names the offending key').toMatch(/add_node_ids/);
    expect(rejectionIssuePaths(result.detail), 'the offender reaches the shared issue-path reader')
      .toContain('add_node_ids');
  });

  it('accepts is_update on the completed stage, where the offered schema still carries it', async () => {
    const session = new AiSession();
    const epoch = session.beginTurn();
    seedResultGraph(session);
    session.enterCompleted(epoch);
    const probe = handlerProbe(session, epoch);

    const result = parseResult(await executePresentResult({
      ...validPayload(),
      is_update: true,
    }, probe.services));

    expect(result.success, 'the completed stage sees the full schema').toBe(true);
  });
});

describe('present_result — a rewritten model decision is logged', () => {
  it('logs one [Normalize] line per node id the engine canonicalised', async () => {
    const session = new AiSession();
    const epoch = session.beginTurn();
    seedResultGraph(session);
    const probe = handlerProbe(session, epoch);

    const result = parseResult(await executePresentResult(validPayload('[DBO].[ORDERS]'), probe.services));

    expect(result.success, 'the case-variant id resolves and the render commits').toBe(true);
    const lines = NORMALIZE_LINES(probe.debugLines);
    expect(lines.length, 'one line for each of sections, notes and highlight_groups').toBe(3);
    expect(lines.every(line => line.includes('from=[DBO].[ORDERS]') && line.includes(`to=${ORIGIN_NODE}`)),
      'both the sent and the stored value are on the line').toBe(true);
    expect(lines.some(line => line.includes('field=sections.0.node_ids.0')), 'the field path is dotted with indices').toBe(true);
    expect(lines.some(line => line.includes('field=notes.0.node_id')), 'notes carry their own path').toBe(true);
    expect(lines.some(line => line.includes('field=highlight_groups.0.node_ids.0')), 'highlight groups carry their own path').toBe(true);
  });

  it('logs nothing when the model sent the canonical id', async () => {
    const session = new AiSession();
    const epoch = session.beginTurn();
    seedResultGraph(session);
    const probe = handlerProbe(session, epoch);

    const result = parseResult(await executePresentResult(validPayload(), probe.services));

    expect(result.success, 'a clean payload commits').toBe(true);
    expect(NORMALIZE_LINES(probe.debugLines), 'an unchanged value costs no log line').toEqual([]);
  });

  it('logs the preview prose the engine replaced with the discovery narrative', async () => {
    const session = new AiSession();
    const epoch = session.beginTurn();
    session.activeLmStage = { kind: 'visual_preview' };
    session.lastDiscoveryAnswer = '# Orders Lineage\n\nOrders is the sole source table.';
    session.lastDiscoveryQuestion = 'What feeds Orders?';
    session.discoveryScopeArtifact = {
      turnEpoch: epoch,
      origin: ORIGIN_NODE,
      direction: 'bidirectional',
      nodeIds: [ORIGIN_NODE],
      edges: [],
    };
    const probe = handlerProbe(session, epoch);

    const result = parseResult(await executePresentResult({
      ...validPayload(),
      summary: 'A summary the model authored itself.',
    }, probe.services));

    expect(result.success, 'the preview commits on engine-owned prose').toBe(true);
    const lines = NORMALIZE_LINES(probe.debugLines);
    expect(lines.some(line => line.includes('field=summary') && line.includes('from=A summary the model authored itself.')),
      'the replaced model text is visible in the log').toBe(true);
  });
});
