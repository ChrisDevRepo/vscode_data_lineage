/** Rejects unclosed SQL references at the real handler boundary; indexed repair retains valid report content and controls. */
import { describe, expect, it } from 'vitest';
import { expandEvidenceRefs } from '../../../src/ai/tools/presentResult';
import { presentResultRepairPatchSchemaForFields } from '../../../src/ai/tools/toolSchemas';
import { marked } from 'marked';
import { AiSession } from '../../../src/ai/session/session';
import { executePresentResult } from '../../../src/ai/tools/handlers/presentResult';
import type { ToolServices } from '../../../src/ai/tools/handlers/toolServices';
import type { ResultGraph } from '../../../src/ai/session/types';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import type { Logger } from '../../../src/utils/log';

const ORIGIN = '[dbo].[Orders]';
const CAPTURED_SQL = 'SELECT * FROM Staging.Orders';

function node(id: string, name: string, type: string): LineageNode {
  return { id, schema: 'dbo', name, fullName: id, type } as unknown as LineageNode;
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
function seedSession(): AiSession {
  const session = new AiSession();
  const resultGraph: ResultGraph = {
    nodeIds: [ORIGIN],
    edges: [],
    source: 'graph',
    originNodeId: ORIGIN,
  };
  session.resultGraph = resultGraph;
  session.memory.storeDetail(
    node(ORIGIN, 'Orders', 'table'),
    [{ angle: 'technical', text: `Loads orders.\n\`\`\`sql\n${CAPTURED_SQL}\n\`\`\`` }],
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
    requireGraph: () => { throw new Error('requireGraph is not part of the present_result path'); },
    logAndReturn: (_toolName: string, data: object) => JSON.stringify(data),
    buildActiveFilter: () => { throw new Error('buildActiveFilter is not part of the present_result path'); },
    toolError: (toolName: string, err: unknown) => JSON.stringify({ code: 'internal_error', reason: String(err), detail: { tool: toolName } }),
  } as unknown as ToolServices;
}

async function run(session: AiSession, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const epoch = session.beginTurn();
  return JSON.parse(await executePresentResult(input, services(session, epoch))) as Record<string, unknown>;
}

function basePayload(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    name: 'Orders Lineage',
    summary: 'How Orders is populated.',
    sections: [{ label: 'Source', node_ids: [ORIGIN], text: 'Orders is the origin.' }],
    highlight_groups: [{ label: 'Flow', color: 'source', node_ids: [ORIGIN] }],
    ...extra,
  };
}

function description(session: AiSession): string {
  return session.presentationArtifact?.aiMetadata.description ?? '';
}

describe('presentation SQL-reference fence boundary', () => {
  it('rejects all unclosed reference openers without consuming the following business prose', async () => {
    const session = seedSession();
    const malformed = Array.from({ length: 55 }, (_, index) => `Rule ${index + 1} stays in the report.\n\`\`\`sql S1\n`).join('\n');
    const epoch = session.beginTurn();
    const input = basePayload({ sections: [{ label: 'Source', node_ids: [ORIGIN], text: malformed }] });
    const result = JSON.parse(await executePresentResult(input, services(session, epoch)));
    expect(result.code).toBe('validation');
    expect(String(result.reason)).toContain('Unclosed SQL fence');
    expect(session.presentationArtifact).toBeFalsy();
    expect(session.presentResultRepairDraft.get()?.sections?.[0]?.text).toBe(malformed);
  });

  it('repairs only the malformed section text in the same turn and preserves all held report controls', async () => {
    const session = seedSession();
    const epoch = session.beginTurn();
    const sourceText = 'Source rule.\n```sql S1\nLater business meaning.';
    const keptText = 'A complete valid business section, unchanged.';
    const input = basePayload({ title: 'Held title', intro: 'Held introduction', closing: 'Held conclusion', notes: [{node_id: ORIGIN, caption: 'Held note'}], sections: [
      { label: 'Source', node_ids: [ORIGIN], text: sourceText },
      { label: 'Meaning', node_ids: [ORIGIN], text: keptText },
    ] });
    const failed = JSON.parse(await executePresentResult(input, services(session, epoch)));
    expect(failed.code).toBe('validation');
    const auth = session.presentResultRepairDraft.getAuthorization()!;
    expect(auth.sectionTextLeaves).toEqual([{ index: 0, fields: ['text'] }]);
    const servedSchema = presentResultRepairPatchSchemaForFields(auth.fields, 'synthesis', 0, auth.highlightLabelIndexes, auth.sectionTextLeaves);
    expect(servedSchema.safeParse({ sections: [{ index: 0, node_ids: [], text: 'Replacement' }] }).success).toBe(false);
    const repaired = JSON.parse(await executePresentResult({ sections: [{ index: 0, node_ids: [], text: 'Source rule.\n```sql S1\n```\nLater business meaning.' }] }, services(session, epoch)));
    expect(repaired.success).toBe(true);
    const rendered = description(session);
    expect(rendered).toContain(CAPTURED_SQL);
    for (const kept of ['Held title','Held introduction','Held conclusion',keptText,'Later business meaning.']) expect(rendered).toContain(kept);
    expect(session.presentationArtifact?.nodeIds).toEqual([ORIGIN]);
    expect(session.presentationArtifact?.aiMetadata.highlightGroups).toEqual([{ label: 'Flow', color: 'source', nodeIds: [ORIGIN] }]);
    expect(session.presentationArtifact?.aiMetadata.notes).toEqual([{nodeId: ORIGIN, text: 'Held note'}]);
    expect(marked.lexer(rendered).filter(token => token.type === 'code')).toHaveLength(1);
    expect(session.presentResultRepairDraft.get()).toBeNull();
  });

  it.each(['title', 'intro', 'closing'])('rejects and repairs malformed SQL in %s while keeping the complete section list', async field => {
    const session = seedSession();
    const epoch = session.beginTurn();
    const malformed = 'Before.\n```sql S1\nAfter.';
    const input = basePayload({ [field]: malformed });
    const failed = JSON.parse(await executePresentResult(input, services(session, epoch)));
    expect(failed.code).toBe('validation');
    expect(failed.issuePaths).toContain(field);
    expect(session.presentationArtifact).toBeFalsy();
    expect(session.presentResultRepairDraft.get()?.sections).toEqual(input.sections);
    expect(session.presentResultRepairDraft.getAuthorization()?.fields).toEqual([field]);
    const repaired = JSON.parse(await executePresentResult({ [field]: 'Before.\n```sql S1\n```\nAfter.' }, services(session, epoch)));
    expect(repaired.success).toBe(true);
    expect(description(session)).toContain('Before.');
    expect(description(session)).toContain('After.');
    expect(description(session)).toContain(CAPTURED_SQL);
    expect(session.presentationArtifact?.nodeIds).toEqual([ORIGIN]);
  });

  it('does not use another language opener to close SQL or consume its intervening prose', () => {
    const text = '```sql S1\nBusiness meaning remains.\n```json\n{"value":1}\n```';
    const expanded = expandEvidenceRefs(text, new Map());
    expect(expanded.text).toBe(text);
    expect(expanded.malformedRefs).toEqual(['S1']);
    expect(expanded.normalized).toEqual([]);
  });

  it('rejects a stale-turn repair without publishing the held draft', async () => {
    const session = seedSession();
    const epoch = session.beginTurn();
    await executePresentResult(basePayload({ intro: '```sql S1\nUnclosed.' }), services(session, epoch));
    session.beginTurn();
    const rejected = JSON.parse(await executePresentResult({ intro: '```sql S1\n```' }, services(session, epoch)));
    expect(rejected.code).toBe('stale_turn');
    expect(session.presentationArtifact).toBeFalsy();
  });

  it.each(['```sql S1\n```', '```sql S1```', '```sql S1\nSELECT 2;\n```'])('keeps closed references and own SQL accepted: %s', async text => {
    const session = seedSession();
    expect((await run(session, basePayload({intro:text}))).success).toBe(true);
    expect(description(session)).toContain(text.includes('SELECT 2') ? 'SELECT 2;' : CAPTURED_SQL);
  });

  it.each(['``` sql S2', '```\tjson'])('does not treat a horizontally spaced language opener as a close: %s', async next => {
    const session = seedSession();
    const text = `First rule.\n\`\`\`sql S1\nBusiness prose.\n${next}\nLater prose.`;
    expect((await run(session, basePayload({ intro: text }))).code).toBe('validation');
    expect(session.presentationArtifact).toBeFalsy();
  });

  it('retains bare closes followed by newline prose, inline punctuation and existing prose-bearing closing markers', () => {
    const blocks = new Map([['S1', { id: 'S1', nodeId: ORIGIN, raw: `\`\`\`sql\n${CAPTURED_SQL}\n\`\`\`` }]]);
    for (const text of ['```sql S1\n```\nNext paragraph.', '```sql S1```! Next paragraph.', '```sql\nSELECT 2;\n``` The adjustment is a hardcoded fallback multiplier.']) {
      const result = expandEvidenceRefs(text, blocks);
      expect(result.malformedRefs).toEqual([]);
      expect(result.text).toContain(text.includes('SELECT 2') ? 'SELECT 2;' : CAPTURED_SQL);
      expect(result.text).toContain(text.includes('adjustment') ? 'The adjustment is a hardcoded fallback multiplier.' : 'Next paragraph.');
    }
  });

  it('rejects a closed unknown reference and leaves non-SQL markdown prose untouched', async () => {
    const session = seedSession();
    expect((await run(session, basePayload({intro:'```sql S9\n```'}))).code).toBe('validation');
    const text = 'Ordinary S1 reference and ```json\n{"value":"S1"}\n```.';
    expect(expandEvidenceRefs(text, new Map()).text).toBe(text);
  });
});
