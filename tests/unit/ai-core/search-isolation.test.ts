/** Protects complete AI search contracts when native-regexp execution is isolated. */
import { expect, it } from 'vitest';
import { searchObjects, searchDdl } from '../../../src/ai/tools/tools';
import { DEFAULT_TURN_TOKEN_BUDGET } from '../../../src/ai/support/tokenBudget';
import type { DatabaseModel } from '../../../src/engine/types';

const model = {
  nodes: [{ id: 'dbo.Order', name: 'Order', schema: 'dbo', type: 'view', bodyScript: 'SELECT HeadToken FROM dbo.Order\n-- HeadToken\nTailToken' }],
  edges: [],
} as unknown as DatabaseModel;

it('serves complete native-regexp object results and schema-widening evidence', async () => {
  const result = await searchObjects(model, '(?<=dbo\\.)Order', undefined, undefined, 'regex');
  expect(result).toMatchObject({ total: 1, results: [{ id: 'dbo.Order' }] });
  const missing = await searchObjects(model, '(?<=dbo\\.)Order', undefined, ['other'], 'regex');
  expect(missing).toMatchObject({ total: 0, ai_hint: expect.stringContaining('exists in [dbo]') });
});

it('serves every DDL match, exact source lines and comment evidence', async () => {
  const result = await searchDdl(model, 'HeadToken|TailToken', DEFAULT_TURN_TOKEN_BUDGET);
  expect(result).toMatchObject({ total: 3, objects: 1, results: [{ line: 1 }, { line: 2, commented: true }, { line: 3 }], by_object: [{ hits: 3, commented_hits: 1 }] });
});

it('keeps malformed regex rejection at the served tool boundary', async () => {
  expect(await searchDdl(model, '[invalid', DEFAULT_TURN_TOKEN_BUDGET)).toMatchObject({ code: 'invalid_regex' });
});

it('refuses an actual malicious body search with a repair hint and no partial answer', async () => {
  const malicious = { ...model, nodes: [{ ...model.nodes[0], bodyScript: 'a'.repeat(50_000) }] };
  const result = await searchDdl(malicious, '(a+)+x', DEFAULT_TURN_TOKEN_BUDGET);
  expect(result).toMatchObject({ code: 'invalid_regex', hint: expect.stringContaining('execution deadline') });
  expect(result).not.toHaveProperty('results');
});

it('propagates registry cancellation without recording a model rejection or internal error', async () => {
  const { AiSession } = await import('../../../src/ai/session/session');
  const { buildAiToolRegistry } = await import('../../../src/ai/tools/toolProvider');
  const { vi } = await import('vitest');
  const session = new AiSession();
  session.model = { ...model, nodes: [{ ...model.nodes[0], bodyScript: 'a'.repeat(50_000) }] };
  const epoch = session.beginTurn();
  const controller = new AbortController();
  const error = vi.fn();
  const channel = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error } as unknown as Parameters<typeof buildAiToolRegistry>[1];
  const registry = buildAiToolRegistry(() => session, channel, () => undefined, { sessionId: 'test', epoch, signal: controller.signal });
  const pending = registry.invoke('lineage_search_ddl', { query: '(a+)+x' });
  const timer = setTimeout(() => controller.abort(), 100);
  try { await expect(pending).rejects.toMatchObject({ name: 'AbortError' }); }
  finally { clearTimeout(timer); }
  expect(session.hopLog).toHaveLength(0);
  expect(error).not.toHaveBeenCalled();
});

it('prevents a superseded search from recording results in the newer turn', async () => {
  const { AiSession } = await import('../../../src/ai/session/session');
  const { buildAiToolRegistry } = await import('../../../src/ai/tools/toolProvider');
  const { vi } = await import('vitest');
  const session = new AiSession();
  session.model = { ...model, nodes: [{ ...model.nodes[0], bodyScript: 'a'.repeat(50_000) }] };
  const epoch = session.beginTurn();
  const controller = new AbortController();
  const error = vi.fn();
  const channel = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error } as unknown as Parameters<typeof buildAiToolRegistry>[1];
  const registry = buildAiToolRegistry(() => session, channel, () => undefined, { sessionId: 'test', epoch, signal: controller.signal });
  const pending = registry.invoke('lineage_search_ddl', { query: '(a+)+x' });
  session.beginTurn();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(session.hopLog).toHaveLength(0);
  expect(error).not.toHaveBeenCalled();
});
