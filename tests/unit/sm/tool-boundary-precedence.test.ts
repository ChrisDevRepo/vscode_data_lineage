/**
 * The strict boundary that runs first owns these rejections, so the handler and engine never see the
 * shapes below: a start with no origin/supplement/revision, a non-string scope list, an empty
 * highlight-group list in any served present_result stage, and a neighbour id the engine has not
 * validated as an in-scope direct neighbour.
 */
import { describe, expect, it } from 'vitest';
import { AiSession } from '../../../src/ai/session/session';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { buildAiToolRegistry } from '../../../src/ai/tools/toolProvider';
import { executeStartExploration } from '../../../src/ai/tools/handlers/startExploration';
import { StartExplorationInputSchema, presentResultSchemaForPhase } from '../../../src/ai/tools/toolSchemas';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { stubToolServices } from './helpers/toolServices';

const ORIGIN = '[hop].[origin]';
const BRANCH = '[hop].[branch]';
const OTHER = '[hop].[other]';

function ctWorld() {
  const column = [{ name: 'Value', type: 'int', nullable: 'NULL', extra: '' }];
  const nodes = [
    makeNode({ id: ORIGIN, schema: 'hop', name: 'origin', type: 'view', columns: column, bodyScript: `SELECT Value FROM ${BRANCH};` }),
    makeNode({ id: BRANCH, schema: 'hop', name: 'branch', type: 'view', columns: column, bodyScript: 'SELECT 1 AS Value;' }),
    makeNode({ id: OTHER, schema: 'hop', name: 'other', type: 'table', columns: column }),
  ];
  const pairs: Array<[string, string]> = [[BRANCH, ORIGIN]];
  const model = makeModel(nodes, pairs, ['hop']);
  model.neighborIndex = { [ORIGIN]: { in: [BRANCH], out: [] }, [BRANCH]: { in: [], out: [ORIGIN] }, [OTHER]: { in: [], out: [] } };
  const graph = makeGraph(nodes, pairs);
  const session = new AiSession();
  session.model = model; session.graph = graph; session.setClassification('technical'); session.beginTurn();
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.classification = 'technical';
  expect(engine.init({ origin: ORIGIN, question: 'Trace Value.', analysisMode: 'ct', targetColumns: ['Value'], direction: 'upstream',
    depthIntent: { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } } })).toMatchObject({ ok: true });
  engine.getHopContext();
  session.stateMachine = engine;
  session.enterExploring(session.turnEpoch);
  const noop = () => {};
  const registry = buildAiToolRegistry(() => session, { info: noop, debug: noop, warn: noop, error: noop } as never, () => undefined);
  return { session, model, graph, registry };
}

describe('lineage_start_exploration boundary', () => {
  it.each([{}, { question: 'What feeds it?' }, { excludeTypes: ['table'] }])('rejects a start with no origin, supplement or revision at the schema: %j', input => {
    const parsed = StartExplorationInputSchema.safeParse(input);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.some(issue => issue.code === 'custom' && (issue as { params?: { startIssue?: string } }).params?.startIssue === 'start_shape_required')).toBe(true);
  });

  it('answers that start with the schema rejection before the handler reads origin', async () => {
    const { session, model, graph } = ctWorld();
    session.stateMachine = null;
    const { services } = stubToolServices({ session, model, graph });
    const result = JSON.parse(await executeStartExploration({ question: 'What feeds it?' }, services));
    expect(result).toMatchObject({ code: 'missing_field', detail: { issues: [expect.objectContaining({ path: '(root)', code: 'missing_field' })] } });
  });

  it('answers an origin plus supplement with the two valid call shapes and no keep-every-field tail', async () => {
    const { session, model, graph } = ctWorld();
    session.stateMachine = null;
    const { services } = stubToolServices({ session, model, graph });
    const text = await executeStartExploration({ origin: ORIGIN, analysisMode: 'bb', classification: 'technical', depth: { upstream: { levels: 1, exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } }, supplement: { nodeIds: [OTHER] } } as never, services);
    expect(text).toMatch(/supplement alone/);
    expect(text).toMatch(/origin without supplement/);
    expect(text).not.toContain('keep every other field unchanged');
  });

  it.each(['excludeTypes', 'excludeSchemas', 'excludeNodeIds', 'passNodeIds', 'scopeNotes'])('rejects a non-string-array %s at the schema', field => {
    expect(StartExplorationInputSchema.safeParse({ origin: ORIGIN, [field]: [1] }).success).toBe(false);
    expect(StartExplorationInputSchema.safeParse({ origin: ORIGIN, [field]: 'one' }).success).toBe(false);
  });
});

describe('lineage_present_result boundary', () => {
  const base = { name: 'View', summary: 'Summary.', sections: [{ label: 'One', node_ids: [ORIGIN], text: 'Body.' }] };
  it.each([
    ['completed', false], ['completed', true], ['synthesis', false], ['synthesis', true],
  ] as const)('rejects missing or empty highlight_groups in the %s schema (retainable=%s)', (stage, retainable) => {
    const schema = presentResultSchemaForPhase(stage, null, retainable);
    expect(schema.safeParse({ ...base, is_update: stage === 'completed' ? true : undefined }).success).toBe(false);
    expect(schema.safeParse({ ...base, highlight_groups: [] }).success).toBe(false);
  });

  it('rejects empty highlight_groups in the preview schema and in a repair patch', () => {
    const preview = presentResultSchemaForPhase('visual_preview', null, false, 1);
    expect(preview.safeParse({ name: 'View', sections: [{ label: 'One', node_ids: [ORIGIN], start: 'B1' }], highlight_groups: [] }).success).toBe(false);
    const repair = presentResultSchemaForPhase('completed', ['highlight_groups']);
    expect(repair.safeParse({ highlight_groups: [] }).success).toBe(false);
  });
});

describe('lineage_get_neighbor_columns boundary', () => {
  it.each(['[hop].[missing]', 'hop.missing', OTHER])('refuses %s at the engine before any column lookup', async id => {
    const { registry } = ctWorld();
    const result = JSON.parse(await registry.invoke('lineage_get_neighbor_columns', { ids: [id] }));
    expect(result).toMatchObject({ code: 'out_of_scope_or_not_neighbor' });
    expect(result).not.toHaveProperty('results');
  });

  it('resolves a case variant of a validated neighbour to its full row', async () => {
    const { registry } = ctWorld();
    const result = JSON.parse(await registry.invoke('lineage_get_neighbor_columns', { ids: ['HOP.BRANCH'] }));
    expect(result).toMatchObject({ total: 1, results: [{ id: BRANCH, columns: [expect.objectContaining({})] }] });
    expect(JSON.stringify(result)).not.toContain('not_found');
  });
});
