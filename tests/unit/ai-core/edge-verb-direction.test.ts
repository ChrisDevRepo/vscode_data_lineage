import { describe, expect, it } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { edgeApiType } from '../../../src/ai/support/aiPresenter';
import { buildEdgeTypeMap } from '../../../src/ai/tools/tools';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { driveEngine, makeModel, makeNode } from '../sm/helpers/fixtures';

/**
 * Regression coverage for the read/write presentation defect: `LineageEdge.type` records
 * provenance (`body` vs `exec`), never direction, so every `body` edge previously presented
 * as `'read'` to the AI even when it was a mutation. `edgeApiType` now takes the edge's source
 * node type as a required second argument and answers `'write'` for a `body` edge sourced from
 * a procedure — the sole node kind that ever emits an outbound `body` edge for a mutation.
 */
describe('edge verb direction', () => {
  describe('edgeApiType — pure function contract', () => {
    it.each([
      ['body', 'procedure', 'write'],
      ['body', 'table', 'read'],
      ['body', 'view', 'read'],
      ['exec', 'procedure', 'exec'],
      ['SELECT', 'view', 'read'],
    ] as const)('edgeApiType(%s, %s) presents as %s', (edgeType, sourceType, expected) => {
      expect(edgeApiType(edgeType, sourceType)).toBe(expected);
    });
  });

  // Mirrors the reported spImportOrders/ErrorLog shape: a procedure writes to a table, that
  // table feeds a view (a table-sourced read), and the view feeds a second view (a
  // view-sourced read), while the procedure also execs a second procedure.
  const nodes: LineageNode[] = [
    makeNode({ id: 'origin',       schema: 'dbo', name: 'origin',       type: 'procedure' }),
    makeNode({ id: 'error_log',    schema: 'dbo', name: 'error_log',    type: 'table' }),
    makeNode({ id: 'archive_view', schema: 'dbo', name: 'archive_view', type: 'view' }),
    makeNode({ id: 'report_view',  schema: 'dbo', name: 'report_view',  type: 'view' }),
    makeNode({ id: 'called_proc',  schema: 'dbo', name: 'called_proc',  type: 'procedure' }),
  ];
  const edgePairs: Array<[string, string]> = [
    ['origin', 'error_log'],
    ['error_log', 'archive_view'],
    ['archive_view', 'report_view'],
    ['origin', 'called_proc'],
  ];
  const model: DatabaseModel = makeModel(nodes, edgePairs, ['dbo']);
  const originToCalledProc = model.edges.find(e => e.source === 'origin' && e.target === 'called_proc');
  if (originToCalledProc) originToCalledProc.type = 'exec';
  const graph = makeGraph(nodes, edgePairs);

  describe('buildEdgeTypeMap — tool-facing edge presentation', () => {
    const edgeTypeMap = buildEdgeTypeMap(model);

    it.each([
      ['origin→error_log', 'write', 'the procedure-sourced mutation'],
      ['error_log→archive_view', 'read', 'the table-sourced dependency'],
      ['archive_view→report_view', 'read', 'the view-sourced dependency'],
      ['origin→called_proc', 'exec', 'the exec call'],
    ])('%s presents as %s (%s)', (pair, expected) => {
      expect(edgeTypeMap.get(pair)).toBe(expected);
    });
  });

  describe('NavigationEngine.getResult — end-to-end symptom closure', () => {
    it('the assembled edge list and the walked topology agree on every verb', () => {
      const engine = new NavigationEngine(model, graph, () => {}, {});
      engine.init({
        origin: 'origin',
        question: 'edge verb direction',
        direction: 'downstream',
        depthIntent: { kind: 'explicit', levels: 3 },
      });
      driveEngine(engine, { followDownstream: true });

      const result = engine.getResult();
      const edgeByPair = new Map(result.edges.map(([source, target, type]) => [`${source}→${target}`, type]));

      expect(edgeByPair.get('origin→error_log')).toBe('write');
      expect(edgeByPair.get('error_log→archive_view')).toBe('read');
      expect(edgeByPair.get('archive_view→report_view')).toBe('read');
      expect(edgeByPair.get('origin→called_proc')).toBe('exec');
    });
  });
});
