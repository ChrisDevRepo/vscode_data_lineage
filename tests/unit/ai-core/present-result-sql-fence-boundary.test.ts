/** Rejects malformed or unknown SQL references at their owning field; whole-list correction retains report content and controls. */
import { describe, expect, it, vi } from 'vitest';
import { expandEvidenceRefs } from '../../../src/ai/tools/presentResult';
import { AiSession } from '../../../src/ai/session/session';
import { executePresentResult } from '../../../src/ai/tools/handlers/presentResult';
import type { ToolServices } from '../../../src/ai/tools/handlers/toolServices';
import type { ResultGraph } from '../../../src/ai/session/types';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import type { Logger } from '../../../src/utils/log';

const ORIGIN = '[dbo].[Orders]';
const CAPTURED_SQL = 'SELECT * FROM Staging.Orders';

function node(id: string, name: string, type: string): LineageNode {
  return {
    id,
    schema: 'dbo',
    name,
    fullName: id,
    type,
  } as unknown as LineageNode;
}

const TEST_MODEL = {
  nodes: [node(ORIGIN, 'Orders', 'table')],
  edges: [],
} as unknown as DatabaseModel;

const SILENT_LOGGER = {
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
} as unknown as Logger;

/** One captured SQL block on {@link ORIGIN}, assigned id `S1` by `assignEvidenceIds`. */
function seedSession(sql = CAPTURED_SQL): AiSession {
  const session = new AiSession();
  const resultGraph: ResultGraph = {
    nodeIds: [ORIGIN],
    evidenceNodeIds: [ORIGIN],
    edges: [],
    source: 'graph',
    originNodeId: ORIGIN,
  };
  session.resultGraph = resultGraph;
  session.memory.storeDetail(
    node(ORIGIN, 'Orders', 'table'),
    [{ angle: 'technical', text: `Loads orders.\n\`\`\`sql\n${sql}\n\`\`\`` }],
    'Loads orders.',
  );
  return session;
}

function services(session: AiSession, epoch: number): ToolServices {
  return {
    getSession: () => session,
    getPanel: () => undefined as never,
    logger: SILENT_LOGGER,
    turnEpoch: () => epoch,
    requireModel: () => TEST_MODEL,
    requireGraph: () => {
      throw new Error('requireGraph is not part of the present_result path');
    },
    logAndReturn: (_toolName: string, data: object) => JSON.stringify(data),
    buildActiveFilter: () => {
      throw new Error(
        'buildActiveFilter is not part of the present_result path',
      );
    },
    toolError: (toolName: string, err: unknown) =>
      JSON.stringify({
        code: 'backend_fault',
        reason: String(err),
        detail: { tool: toolName },
      }),
  } as unknown as ToolServices;
}

async function run(
  session: AiSession,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const epoch = session.beginTurn();
  return JSON.parse(
    await executePresentResult(input, services(session, epoch)),
  ) as Record<string, unknown>;
}

function basePayload(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    name: 'Orders Lineage',
    summary: 'How Orders is populated.',
    sections: [
      {
        label: 'Source',
        node_ids: [ORIGIN],
        text: 'Orders is the origin.\n```sql S1\n```',
      },
    ],
    highlight_groups: [{ label: 'Flow', color: 'source', node_ids: [ORIGIN] }],
    ...extra,
  };
}

function description(session: AiSession): string {
  return session.presentationArtifact?.aiMetadata.description ?? '';
}

describe('presentation SQL-reference fence boundary', () => {
  it('accepts AI-selected content without autofilling omitted SQL and measures coverage', async () => {
    const session = seedSession();
    const input = basePayload({
      sections: [
        { label: 'Source', node_ids: [ORIGIN], text: 'Orders is the origin.' },
      ],
    });
    const original = structuredClone(input);
    const log = vi.spyOn(SILENT_LOGGER, 'debug');
    try {
      expect((await run(session, input)).success).toBe(true);
      expect(input).toEqual(original);
      expect(description(session)).toContain('Orders is the origin.');
      expect(description(session)).not.toContain(CAPTURED_SQL);
      expect(
        log.mock.calls.some(([message]) =>
          message.includes('fences served=1 shown=0 unused=[S1]'),
        ),
      ).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it('rejects a closed unknown reference and leaves non-SQL markdown prose untouched', async () => {
    const session = seedSession();
    expect(
      (await run(session, basePayload({ intro: '```sql S9\n```' }))).code,
    ).toBe('invalid_input');
    const text = 'Ordinary S1 reference and ```json\n{"value":"S1"}\n```.';
    expect(expandEvidenceRefs(text, new Map()).text).toBe(text);
  });
});
