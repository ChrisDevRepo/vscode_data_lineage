/** Rejects unclosed SQL references at the real handler boundary; indexed repair retains valid report content and controls. */
import { describe, expect, it } from 'vitest';
import { expandEvidenceRefs } from '../../../src/ai/tools/presentResult';
import { PresentResultModelSchema, presentResultRepairPatchSchemaForFields } from '../../../src/ai/tools/toolSchemas';
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
    expect(session.presentResultRepairDraft.get()?.sections?.[0]?.text).toBe(malformed.trim());
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
    const repaired = JSON.parse(await executePresentResult({ sections: [{ index: 0, text: 'Source rule.\n```sql S1\n```\nLater business meaning.' }] }, services(session, epoch)));
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
    for (const text of ['```sql S1\n```\nNext paragraph.', '```sql S1```! Next paragraph.', '```sql S1```Next paragraph.', '```sql\nSELECT 2;\n``` The adjustment is a hardcoded fallback multiplier.']) {
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


describe('evidence reference placement on its own line', () => {
  const SQL = 'SELECT SUM(Amount) FROM Demo.Sales';
  const blocks = new Map([['S1', { id: 'S1', nodeId: ORIGIN, raw: `\`\`\`sql\n${SQL}\n\`\`\`` }]]);
  const fence = (indent: string): string => `${indent}\`\`\`sql\n${indent}${SQL}\n${indent}\`\`\``;

  it('keeps a mid-line reference in an ordered list item inside the item and the later steps numbered', () => {
    const written = '1. Country denominator: $$S=\\sum x$$ (```sql S1\n```)\n2. Second step.\n3. Third step.';
    const { text } = expandEvidenceRefs(written, blocks);
    expect(text).toBe(`1. Country denominator: $$S=\\sum x$$\n${fence('   ')}\n2. Second step.\n3. Third step.`);
    const tokens = marked.lexer(text);
    expect(tokens.map(token => token.type)).toEqual(['list']);
    const list = tokens[0] as { items: Array<{ tokens: Array<{ type: string; text: string }> }> };
    expect(list.items).toHaveLength(3);
    expect(list.items[0].tokens.filter(token => token.type === 'code').map(token => token.text)).toEqual([SQL]);
    expect(list.items[1].tokens[0].text).toBe('Second step.');
    expect(list.items[2].tokens[0].text).toBe('Third step.');
  });

  it('starts the block on its own line in a plain paragraph and continues the prose after it', () => {
    const { text } = expandEvidenceRefs('Revenue is summed ```sql S1```, per country.', blocks);
    expect(text).toBe(`Revenue is summed\n${fence('')}\n, per country.`);
    expect(marked.lexer(text).filter(token => token.type === 'code')).toHaveLength(1);
  });

  it('indents every line of a block in a nested list item to that item\'s content column', () => {
    const { text } = expandEvidenceRefs('1. Outer\n   - Inner step (```sql S1\n```) done.\n2. Next', blocks);
    expect(text).toBe(`1. Outer\n   - Inner step\n${fence('     ')}\n     done.\n2. Next`);
    const outer = (marked.lexer(text)[0] as { items: Array<{ tokens: Array<{ type: string; items?: unknown[] }> }> }).items;
    expect(outer).toHaveLength(2);
    expect(outer[0].tokens.find(token => token.type === 'list')?.items).toHaveLength(1);
  });

  it('leaves no empty parentheses when the section already shows that SQL', () => {
    const shown = `\`\`\`sql\n${SQL}\n\`\`\``;
    const inline = expandEvidenceRefs(`${shown}\n\nTotals are summed (\`\`\`sql S1\n\`\`\`) per country.`, blocks);
    expect(inline.text).toBe(`${shown}\n\nTotals are summed per country.`);
    const item = expandEvidenceRefs(`- ${shown.replace(/\n/g, '\n  ')}\n- Total (\`\`\`sql S1\`\`\`)\n- Next`, blocks);
    expect(item.text).toBe(`- ${shown.replace(/\n/g, '\n  ')}\n- Total\n- Next`);
    expect(item.normalized).toEqual([expect.stringContaining('S1')]);
  });

  it.each([
    ['a paragraph', 'Intro.\n\n```sql S1\n```\n\nThen load.', `Intro.\n\n${fence('')}\n\nThen load.`],
    ['a bullet', '- Guard:\n  ```sql S1\n  ```\n- Next', `- Guard:\n${fence('  ')}\n- Next`],
    ['a bullet opener', '- ```sql S1```\n- Next', `- ${fence('  ').trimStart()}\n- Next`],
  ])('expands a reference already on its own line exactly as before: %s', (_name, written, expected) => {
    expect(expandEvidenceRefs(written, blocks).text).toBe(expected);
  });

  it('places a mid-line fence that carries its own SQL on its own line and drops only the id', () => {
    const own = 'SELECT 1;';
    const { text, normalized } = expandEvidenceRefs(`- Rule: \`\`\`sql S1\n${own}\n\`\`\` — applies.\n- Next`, blocks);
    expect(text).toBe(`- Rule:\n  \`\`\`sql\n  ${own}\n  \`\`\`\n  — applies.\n- Next`);
    expect(normalized).toEqual([expect.stringContaining('S1')]);
    const list = marked.lexer(text)[0] as { items: unknown[] };
    expect(list.items).toHaveLength(2);
  });
});


describe('merged report section repair diagnosis', () => {
  it('rejects a contradictory delete-and-replacement before losing held details, then accepts the correction', async () => {
    const session = seedSession(); const epoch = session.beginTurn();
    const held = PresentResultModelSchema.parse(basePayload({}));
    session.presentResultRepairDraft.hold(held, { fields: ['sections'] });
    const contradictory = { sections: [{ label: 'Source', remove: true, node_ids: [ORIGIN], text: 'Corrected source detail.' }] };
    const rejected = JSON.parse(await executePresentResult(contradictory, services(session, epoch)));
    expect(rejected.code).toBe('invalid_input');
    expect(session.presentResultRepairDraft.get()).toEqual(held);
    expect(rejected.hint).toContain('sections: resend only the entries you add or change');
    expect(rejected.hint).not.toContain('repeating the unflagged elements exactly as first sent');
    const corrected = JSON.parse(await executePresentResult({ sections: [{ label: 'Source', node_ids: [ORIGIN], text: 'Corrected source detail.' }] }, services(session, epoch)));
    expect(corrected.success).toBe(true);
    expect(description(session)).toContain('Corrected source detail.');
  });

  it('teaches one keyed correction after a duplicate delete-and-replacement rejection', async () => {
    const session = seedSession(); const epoch = session.beginTurn();
    const held = PresentResultModelSchema.parse(basePayload({}));
    session.presentResultRepairDraft.hold(held, { fields: ['sections'] });
    const rejected = JSON.parse(await executePresentResult({ sections: [{ label: 'Source', remove: true }, { label: 'Source', text: 'Corrected source detail.' }] }, services(session, epoch)));
    expect(rejected.code).toBe('invalid_input');
    expect(rejected.hint).toContain('one entry per section label');
    expect(rejected.hint).toContain('omit remove');
    expect(rejected.hint).not.toContain('repeating the unflagged elements exactly as first sent');
    expect(session.presentResultRepairDraft.get()).toEqual(held);
  });

  it('keeps a duplicate indexed-label repair narrow without claiming the retained report is empty', async () => {
    const session = seedSession();
    const epoch = session.beginTurn();
    const labels = ['Terminal Sources', 'Price Computation Pipeline', 'Order Import and Cleaning', 'Staging and Consolidation', 'Revenue Computation and Load', 'Dimension and Lookup Tables'];
    const held = PresentResultModelSchema.parse(basePayload({ sections: labels.map(label => ({ label, node_ids: [ORIGIN], text: `Evidence for ${label}.` })) }));
    session.presentResultRepairDraft.hold(held, { fields: ['sections'], sectionTextLeaves: [{ index: 3, fields: ['label'] }, { index: 5, fields: ['label'] }] });
    const result = JSON.parse(await executePresentResult({ sections: [{ index: 3, label: 'Staging' }, { index: 5, label: labels[4] }] }, services(session, epoch)));
    expect(result.reason).toContain('Duplicate section label');
    expect(result.issuePaths).toEqual(['sections.5.label']);
    expect(result.hint).not.toContain('no section');
    expect(result.hint).toContain('zero-based 5 (label)');
    expect(session.presentResultRepairDraft.get()?.sections).toHaveLength(6);
    expect(session.presentResultRepairDraft.getAuthorization()).toEqual({ fields: ['sections'], sectionTextLeaves: [{ index: 5, fields: ['label'] }] });
    const auth = session.presentResultRepairDraft.getAuthorization()!;
    const schema = presentResultRepairPatchSchemaForFields(auth.fields, 'synthesis', 0, auth.highlightLabelIndexes, auth.sectionTextLeaves);
    expect(schema.safeParse({ sections: [{ index: 5, label: 'Dimensions', text: 'Rewrite' }] }).success).toBe(false);
    expect(schema.safeParse({ sections: [{ index: 5, label: 'Dimensions' }] }).success).toBe(true);
  });
  it('requests whole sections after the final held section is explicitly dropped', async () => {
    const session = seedSession();
    const epoch = session.beginTurn();
    session.presentResultRepairDraft.hold(PresentResultModelSchema.parse(basePayload({})), { fields: ['sections'] });
    const result = JSON.parse(await executePresentResult({ sections: [{ label: 'Source', remove: true }] }, services(session, epoch)));
    expect(result.issuePaths).toEqual(['sections']);
    expect(result.hint).toContain('No section is held: resend every section.');
    expect(session.presentResultRepairDraft.get()?.sections).toEqual([]);
    expect(session.presentResultRepairDraft.getAuthorization()).toEqual({ fields: ['sections'] });
  });
  it('does not hold keep-text sections of an update call whose labels the committed report lacks', async () => {
    const session = seedSession();
    session.explorationRunId = 'run-1';
    session.phase = { kind: 'completed' };
    session.resultGraph = { ...session.resultGraph!, sectionsRunId: 'run-1', sections: [
      { label: 'Alpha', node_ids: [ORIGIN], text: 'Alpha body.' },
      { label: 'Beta', node_ids: [ORIGIN], text: 'Beta body.' },
    ] } as ResultGraph;
    const first = await run(session, { is_update: true, sections: [{ label: 'Invented One' }, { label: 'Invented Two' }] });
    expect(first.hint).toContain('`Alpha`, `Beta`');
    expect(session.presentResultRepairDraft.get()?.sections).toBeUndefined();
    const second = await run(session, { is_update: true, name: 'Renamed', summary: 'Same report.', highlight_groups: [{ label: 'Feed', color: 'source', node_ids: [ORIGIN] }] });
    expect(second.success).toBe(true);
    expect(session.resultGraph?.sections?.map(sec => sec.label)).toEqual(['Alpha', 'Beta']);
  });

  it('authorizes a section resend when a rejected update loses its sections, so authored text is not dropped', async () => {
    const session = seedSession();
    session.explorationRunId = 'run-1';
    session.phase = { kind: 'completed' };
    session.resultGraph = { ...session.resultGraph!, sectionsRunId: 'run-1', sections: [
      { label: 'Alpha', node_ids: [ORIGIN], text: 'Alpha body.' },
    ] } as ResultGraph;
    const first = await run(session, { is_update: true, sections: [{ label: 'Alpha', text: 'New Alpha body.' }, { label: 'Invented' }] });
    expect(first.hint).toContain('sections');
    expect(first.hint).not.toContain('every field except name, summary, highlight_groups.');
    const second = await run(session, { is_update: true, name: 'Renamed', summary: 'Same report.', highlight_groups: [{ label: 'Feed', color: 'source', node_ids: [ORIGIN] }], sections: [{ label: 'Alpha', node_ids: [ORIGIN], text: 'New Alpha body.' }] });
    expect(second.success).toBe(true);
    expect(session.resultGraph?.sections?.map(sec => sec.text)).toEqual(['New Alpha body.']);
  });
});
