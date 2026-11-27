/**
 * Mutating tool handlers keep object ids and model-authored text off info-level log lines; counts stay at info.
 * The Logger removes credential-shaped text for every caller at every level, so no call site has to.
 */
import { describe, expect, it, vi } from 'vitest';
import { AiSession } from '../../../src/ai/session/session';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { DepthIntent } from '../../../src/ai/sm/smTypes';
import { executeStartExploration } from '../../../src/ai/tools/handlers/startExploration';
import { executePresentResult } from '../../../src/ai/tools/handlers/presentResult';
import { Logger } from '../../../src/utils/log';
import { directionFromDepth } from '../../../src/engine/shared/explorationDepthContract';
import { buildModel } from './helpers/engineFixture';
import { stubToolServices } from './helpers/toolServices';

const BOTH: DepthIntent = { upstream: { levels: 'all', exactness: 'approximate' }, downstream: { levels: 'all', exactness: 'approximate' } };
const node = (id: string, type: 'table' | 'view') => ({ id, type, columns: [] as string[] });
const edge = (source: string, target: string) => ({ source, target, type: 'body' as const });

function channel() {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() };
}

const SECRET = 'hunter2-Zk93';

function completedWorld() {
  const built = buildModel({
    nodes: [node('dbo.O', 'view'), node('dbo.TA', 'view'), node('dbo.VA', 'view'), node('dbo.ISLAND', 'view')],
    edges: [edge('dbo.TA', 'dbo.O'), edge('dbo.VA', 'dbo.TA')], origin: 'dbo.O',
  });
  const engine = new NavigationEngine(built.model, built.graph, () => {}, {});
  expect(engine.init({ question: 'q', origin: 'dbo.O', analysisMode: 'bb', direction: directionFromDepth(BOTH), depthIntent: BOTH })).toMatchObject({ ok: true });
  engine.getHopContext();
  expect(engine.submitFindings({ focus_node_id: 'dbo.O', verdict: 'analyze', summary: 'S', sections: [{ angle: 'technical', text: 'a' }],
    prune_neighbors: [{ id: 'dbo.TA', reason: 'off the answer' }] })).toMatchObject({ ok: true });
  expect(engine.getHopContext().done).toBe(true);
  const session = new AiSession();
  session.model = built.model; session.graph = built.graph;
  session.stateMachine = engine;
  session.enterCompleted();
  const lines = { info: [] as string[], debug: [] as string[] };
  const { services } = stubToolServices({ session, model: built.model, graph: built.graph });
  (services as { logger: unknown }).logger = {
    info: (line: string) => lines.info.push(line), debug: (line: string) => lines.debug.push(line), warn: () => {}, error: () => {},
  };
  return { session, services, lines };
}

describe('tool handler info-log redaction', () => {
  it('logs only counts at info when a supplement is refused, with skipped ids at debug', async () => {
    const { services, lines } = completedWorld();
    const result = JSON.parse(await executeStartExploration({ supplement: { nodeIds: ['dbo.ISLAND'] } }, services));
    expect(result).toMatchObject({ code: 'supplement_all_refused' });
    expect(lines.info).toEqual([expect.stringContaining('skipped=1')]);
    expect(lines.info.join('\n')).not.toContain('dbo.ISLAND');
    expect(lines.debug.join('\n')).toContain('dbo.ISLAND');
  });

  it('logs only counts at info when a supplement is partly admitted, with skipped ids at debug', async () => {
    const { services, lines } = completedWorld();
    const result = JSON.parse(await executeStartExploration({ supplement: { nodeIds: ['dbo.VA', 'dbo.ISLAND'] } }, services));
    expect(result).toMatchObject({ ok: true });
    const phase = lines.info.filter(line => line.includes('[Phase]'));
    expect(phase).toEqual([expect.stringContaining('skipped=1')]);
    expect(lines.info.join('\n')).not.toContain('dbo.ISLAND');
    expect(lines.debug.join('\n')).toContain('dbo.ISLAND');
  });

  it('keeps the model-authored view name and title off info lines of a present_result', async () => {
    const { session, services, lines } = completedWorld();
    session.resultGraph = { nodeIds: ['dbo.O'], edges: [], source: 'blackboard', originNodeId: 'dbo.O' };
    (services as { deliverPreview: unknown }).deliverPreview = vi.fn().mockResolvedValue('delivered');
    const result = JSON.parse(await executePresentResult({
      name: 'Confidential payroll view', title: 'Payroll heading secret', summary: 'Origin only.',
      sections: [{ label: 'Origin', node_ids: ['dbo.O'], text: 'The origin view.' }],
      highlight_groups: [{ label: 'Origin', color: 'target', node_ids: ['dbo.O'] }],
    }, services));
    expect(result).toMatchObject({ success: true });
    const info = lines.info.join('\n');
    expect(info).toContain('nodes=1');
    expect(info).toContain('sections=1');
    expect(info).not.toContain('Confidential payroll view');
    expect(info).not.toContain('Payroll heading secret');
    const debug = lines.debug.join('\n');
    expect(debug).toContain('Confidential payroll view');
    expect(debug).toContain('Payroll heading secret');
  });
});

describe('Logger redaction', () => {
  it.each(['info', 'debug', 'warn'] as const)('removes a credential from a %s line', (level) => {
    const ch = channel();
    Logger.create(ch as never, 'DB')[level](`Connect failed: Server=x;Password=${SECRET};Database=y`);
    const line = String(ch[level].mock.calls[0][0]);
    expect(line).toContain('Server=x');
    expect(line).not.toContain(SECRET);
  });

  it('keeps the message and stack off the error line and redacts them on the debug line', () => {
    const ch = channel();
    const err = Object.assign(new TypeError(`login: Password=${SECRET}`), { code: 'ELOGIN', diagnostic: 'a.b, c' });
    err.stack = `TypeError: login: Password=${SECRET}\n    at connect (db.js:1:1)`;
    Logger.create(ch as never, 'DB').error(`Open Pwd=${SECRET}`, err);
    const errorLines = ch.error.mock.calls.map(([l]) => String(l));
    const debugLines = ch.debug.mock.calls.map(([l]) => String(l));
    expect(errorLines).toEqual(['[DB] FAILED: Open Pwd=[removed] — TypeError code=ELOGIN']);
    expect(debugLines).toHaveLength(1);
    expect(debugLines[0]).toContain('login: Password=[removed]');
    expect(debugLines[0]).toContain('diagnostic=a.b, c');
    expect(debugLines[0]).toContain('at connect (db.js:1:1)');
    expect([...errorLines, ...debugLines].join('\n')).not.toContain(SECRET);
  });

  it('removes a credential from a thrown non-Error value and keeps its text off the error line', () => {
    const ch = channel();
    Logger.create(ch as never, 'DB').error('Open', `rejected Password=${SECRET}`);
    expect(String(ch.error.mock.calls[0][0])).toBe('[DB] FAILED: Open — NonError');
    expect(String(ch.debug.mock.calls[0][0])).toContain('Password=[removed]');
    expect(String(ch.debug.mock.calls[0][0])).not.toContain(SECRET);
  });

  it('keeps an identifier-shaped string off the error line and shows only an explicit code detail', () => {
    const ch = channel();
    const log = Logger.create(ch as never, 'DB');
    log.error('Open', 'dbo.Orders');
    log.error('Load', { code: 'no-config' });
    expect(ch.error.mock.calls.map(([l]) => String(l))).toEqual(['[DB] FAILED: Open — NonError', '[DB] FAILED: Load — code=no-config']);
  });
});
