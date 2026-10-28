/** Approved08 report draft contracts through the actual handler; no repair-only schema or merge protocol. */
import { describe, expect, it } from 'vitest';
import { AiSession } from '../../../src/ai/session/session';
import { executePresentResult } from '../../../src/ai/tools/handlers/presentResult';
import type { ToolServices } from '../../../src/ai/tools/handlers/toolServices';
import { makeIndexedModel, makeNode } from '../helpers/modelFixtures';
import { renderProblem } from '../../../src/ai/support/toolErrorEnvelope';
import { presentResultSchemaForPhase } from '../../../src/ai/tools/toolSchemas';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';

function draftWorld() {
  const ids = ['[dbo].[Result]', '[dbo].[Source]', '[dbo].[Outside]'];
  const model = makeIndexedModel(ids.map(id => makeNode({ id, schema: 'dbo', name: id, type: 'table' })), [[ids[1], ids[0]]]);
  const session = new AiSession();
  const epoch = session.beginTurn();
  session.resultGraph = { nodeIds: ids.slice(0, 2), edges: [[ids[1], ids[0], 'read']], source: 'blackboard', originNodeId: ids[0] };
  session.enterCompleted(epoch);
  const logs: string[] = [];
  const services = {
    getSession: () => session, turnEpoch: () => epoch, requireModel: () => model,
    logger: { debug: (message: string) => logs.push(message), info() {}, warn() {}, error() {} }, deliverPreview: async () => 'delivered',
    logAndReturn: (_tool: string, value: unknown) => JSON.stringify(value),
    toolError: (_tool: string, error: unknown) => { throw error; },
  } as unknown as ToolServices;
  const report = { name: 'Result', summary: 'Source feeds Result.', title: 'Held title sentinel',
    sections: [{ label: 'Flow', node_ids: ids.slice(0, 2), text: 'Source feeds the Result.' }],
    highlight_groups: [{ label: 'Flow', color: 'source' as const, node_ids: ids.slice(0, 2) }] };
  return { session, ids, report, logs, send: async (input: unknown) => JSON.parse(await executePresentResult(input, services)) };
}

describe('Approved08 full-schema report draft boundary', () => {
  it('reports independent schema and report-reference faults together before accepting only their corrections (D-099)', async () => {
    const { session, ids, report, send } = draftWorld();
    const graph = structuredClone(session.resultGraph);
    const rejected = await send({ ...report, summary: 42, notes: [{ node_id: ids[2], caption: 'Outside source is unresolved.' }] });
    expect(rejected.errors).toEqual(expect.arrayContaining([
      { path: 'summary', code: 'type', values: ['string'] },
      { path: 'notes.0.node_id', code: 'result_out_of_scope', values: ids.slice(0, 2) },
    ]));
    expect(session.resultGraph).toEqual(graph);
    expect(session.presentationArtifact).toBeNull();
    expect(await send({ summary: report.summary, notes: [] })).toHaveProperty('success', true);
    expect(session.presentationArtifact?.aiMetadata.description).toContain(report.sections[0].text);
  });

  it('collects independent add, prune and reference faults with a schema fault (D-099)', async () => {
    const { session, ids, report, send } = draftWorld();
    const graph = structuredClone(session.resultGraph);
    const rejected = await send({ ...report, summary: 42, add_node_ids: ['missing-add'], prune_node_ids: ['missing-prune'],
      notes: [{ node_id: ids[2], caption: 'Outside source is unresolved.' }] });
    expect(rejected.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'summary', code: 'type' }),
      expect.objectContaining({ path: 'add_node_ids.0', code: 'not_found' }),
      expect.objectContaining({ path: 'prune_node_ids.0', code: 'not_found' }),
      expect.objectContaining({ path: 'notes.0.node_id', code: 'result_out_of_scope' }),
    ]));
    expect(session.resultGraph).toEqual(graph);
    expect(session.presentationArtifact).toBeNull();
    expect(await send({ summary: report.summary, add_node_ids: [], prune_node_ids: [], notes: [] })).toHaveProperty('success', true);
  });

  it.each((['sections', 'highlight_groups'] as const).flatMap(field => ['not a list', { length: { toString: 42 } }].map(value => ({ field, value }))))('rejects malformed reference container $field=$value without inventing coverage (D-099)', async ({ field, value }) => {
    const { session, report, send } = draftWorld();
    const rejected = await send({ ...report, [field]: value, notes: [{ caption: 'Missing identity.' }] });
    expect(rejected.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: field, code: 'type' }),
      expect.objectContaining({ path: 'notes.0.node_id', code: 'missing' }),
    ]));
    expect(rejected.errors.some((error: { code: string }) => error.code === 'node_unexplained')).toBe(false);
    expect(session.presentationArtifact).toBeNull();
    expect(await send({ [field]: report[field], notes: [] })).toHaveProperty('success', true);
  });

  it('logs an identical saved-field resend as a no-op while still requiring its missing content (D-098)', async () => {
    const { session, report, logs, send } = draftWorld();
    const { summary: _summary, ...incomplete } = report;
    expect(await send(incomplete)).toHaveProperty('code', 'invalid_input');
    const repeated = await send({ name: report.name });
    expect(repeated.errors).toContainEqual(expect.objectContaining({ path: 'summary', code: 'missing' }));
    expect(logs.some(line => line.includes('[Hold] identical resend no-op tool=lineage_present_result'))).toBe(true);
    expect(session.presentationArtifact).toBeNull();
    expect(await send({ summary: report.summary })).toHaveProperty('success', true);
  });

  it.each([42, null, { unexpected: 'label' }])('rejects a malformed section label %j while independently checking its text (D-099)', async label => {
    const { session, report, send } = draftWorld();
    const before = structuredClone(session.resultGraph);
    const rejected = await send({ ...report, sections: [{ ...report.sections[0], label }] });
    expect(rejected).toMatchObject({ code: 'invalid_input' });
    expect(rejected.errors).toContainEqual(expect.objectContaining({ path: 'sections.0.label', code: 'type', values: ['string'] }));
    expect(session.presentationArtifact).toBeNull();
    expect(session.resultGraph).toEqual(before);
    expect(await send({ sections: [{ ...report.sections[0], label: 'Corrected label' }] })).toHaveProperty('success', true);
    expect(session.presentationArtifact?.aiMetadata.description).toContain(report.sections[0].text);
  });

  it('accepts the advertised stage-3 note fallback with sections and resent held fields (D-098/D-105)', async () => {
    const { session, ids, report, send } = draftWorld();
    const rejected = await send({ ...report, notes: [{ node_id: ids[2], caption: 'Outside source is unresolved.' }] });
    expect(rejected.errors).toContainEqual(expect.objectContaining({ path: 'notes.0.node_id', code: 'result_out_of_scope' }));
    expect(JSON.parse(renderProblem(rejected, 3)).resend).toEqual(expect.arrayContaining(['notes', 'sections']));
    const sections = [{ ...report.sections[0], text: 'Source feeds the Result. ⚠️ Outside source remains unresolved.' }];
    expect(await send({ notes: [], sections, name: report.name, title: report.title })).toHaveProperty('success', true);
    expect(session.presentationArtifact?.aiMetadata.description).toContain(sections[0].text);
  });

  it('replaces supplied lists whole rather than merging entries by identity (D-101)', async () => {
    const { session, ids, report, send } = draftWorld();
    await send({ ...report, summary: 42, notes: ids.slice(0, 2).map(node_id => ({ node_id, caption: 'Held caption.' })) });
    expect(await send({ summary: report.summary, notes: [{ node_id: ids[1], caption: 'Only supplied caption.' }] })).toHaveProperty('success', true);
    expect(session.presentationArtifact?.aiMetadata.notes).toEqual([{ nodeId: ids[1], text: 'Only supplied caption.' }]);
  });

  it('keeps a held value on a faulty overwrite, reports it without echo, and accepts the next correction (D-101/D-102)', async () => {
    const { session, report, send } = draftWorld();
    await send({ ...report, summary: 42 });
    const rejected = await send({ summary: report.summary, title: ['new invalid title sentinel'] });
    expect(rejected.errors).toContainEqual(expect.objectContaining({ path: 'title', code: 'not_overwritten' }));
    const shown = renderProblem(rejected, 1);
    expect(shown).not.toContain(report.title);
    expect(shown).not.toContain('new invalid title sentinel');
    expect(await send({ summary: report.summary })).toHaveProperty('success', true);
    expect(session.presentationArtifact?.aiMetadata.description).toContain(report.title);
  });
});

it.each([false, true])('keeps the full served schema and accepts identical or changed held fields (D-098, changed=%s)', async changed => {
  const { session, report, send } = draftWorld();
  const before = toModelJsonSchema(presentResultSchemaForPhase('completed'));
  expect(await send({ ...report, summary: 42 })).toHaveProperty('code', 'invalid_input');
  expect(toModelJsonSchema(presentResultSchemaForPhase('completed'))).toEqual(before);
  const name = changed ? 'Replacement result' : report.name;
  expect(await send({ ...report, name })).toHaveProperty('success', true);
  expect(session.presentationArtifact?.name).toBe(name);
});

it.each(['correct', 'withdraw'] as const)('repairs an optional field with an explicit %s (D-103)', async mode => {
  const { session, report, send } = draftWorld();
  await send({ ...report, summary: 42 });
  expect(await send({ summary: report.summary, title: mode === 'withdraw' ? null : 'Corrected title' })).toHaveProperty('success', true);
  const description = session.presentationArtifact?.aiMetadata.description ?? '';
  expect(description).not.toContain(report.title);
  if (mode === 'correct') expect(description).toContain('Corrected title');
});

it('keeps large section bodies byte-equivalent when only another field needs a correction (D-098/D-102)', async () => {
  const { session, report, send } = draftWorld();
  const text = 'SQL-supported explanation. '.repeat(5000);
  const sections = [{ ...report.sections[0], text }];
  const rejected = await send({ ...report, sections, title: 42 });
  expect(renderProblem(rejected, 1)).not.toContain(text);
  expect(await send({ title: 'Corrected title' })).toHaveProperty('success', true);
  expect(session.presentationArtifact?.aiMetadata.description).toContain(text);
});

it.each(['node ids', 'k'.repeat(130)])('rejects an unknown key and never retains it across correction (Approved08, %s)', async key => {
  const { session, report, send } = draftWorld();
  const rejected = await send({ ...report, summary: 42, [key]: ['untrusted sentinel'] });
  expect(rejected.code).toBe('invalid_input');
  expect(session.presentResultRepairDraft.get()).not.toHaveProperty(key);
  expect(await send({ summary: report.summary })).toHaveProperty('success', true);
  expect(JSON.stringify(session.presentationArtifact)).not.toContain('untrusted sentinel');
});

it.each(['__proto__', 'constructor', 'prototype'].flatMap(key => [null, { untrusted: true }].map(value => ({ key, value }))))('rejects an own JSON key $key without applying inherited object members (Approved08)', async ({ key, value }) => {
  const { report, send } = draftWorld();
  const input = Object.fromEntries([...Object.entries(report), [key, value]]);
  const rejected = await send(input);
  expect(rejected.code).toBe('invalid_input');
  expect(rejected.errors).toContainEqual(expect.objectContaining({ path: key, code: 'unknown_key' }));
});

it('revalidates every required field of a whole-list replacement and accepts its next complete correction (D-099/D-101)', async () => {
  const { session, report, send } = draftWorld();
  await send({ ...report, summary: 42 });
  const rejected = await send({ summary: report.summary, sections: [{ label: 'Incomplete' }] });
  expect(rejected.errors).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: 'sections.0.text', code: 'missing' }),
    expect.objectContaining({ path: 'sections.0.node_ids', code: 'missing' }),
    expect.objectContaining({ path: 'sections', code: 'not_overwritten' }),
  ]));
  expect(session.presentationArtifact).toBeNull();
  expect(await send({ sections: report.sections })).toHaveProperty('success', true);
});

it('rejects retired key/index repair grammar instead of silently merging it (D-101)', async () => {
  const { report, send } = draftWorld();
  await send({ ...report, summary: 42 });
  const rejected = await send({ summary: report.summary, sections: [{ index: 0, label: 'Replacement', remove: true }] });
  expect(rejected.code).toBe('invalid_input');
  expect(rejected.errors).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: 'sections.0.index', code: 'unknown_key' }),
    expect.objectContaining({ path: 'sections.0.remove', code: 'unknown_key' }),
  ]));
  expect(await send({ sections: report.sections })).toHaveProperty('success', true);
});
