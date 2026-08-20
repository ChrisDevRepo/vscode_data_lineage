import { executeSubmitFindings } from '../../../src/ai/tools/handlers/submitFindings';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { ToolServices } from '../../../src/ai/tools/handlers/toolServices';
import { assert, assertEq, makeGraph } from '../helpers/testUtils';
import { describe, it } from 'vitest';

describe("Submit Findings Handler", () => {
  const nodes = [
    { id: 'origin', schema: 'dbo', name: 'Origin', type: 'view' },
    { id: 'a', schema: 'dbo', name: 'A', type: 'view' },
    { id: 'b', schema: 'dbo', name: 'B', type: 'view' },
  ] as any;
  const model = {
    nodes,
    edges: [
      { source: 'origin', target: 'a', type: 'SELECT' },
      { source: 'origin', target: 'b', type: 'SELECT' },
    ],
    schemas: ['dbo'],
    dbPlatform: 'SQL Server',
  } as any;
  function setup() {
    const graph = makeGraph(nodes, [['origin', 'a'], ['origin', 'b']]);
    const engine = new NavigationEngine(model, graph, () => {}, {});
    engine.init({ origin: 'origin', question: 'trace', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 1 } });
    engine.getHopContext();
    let returned: Record<string, unknown> = {};
    const session = {
      stateMachine: engine,
      classification: 'business',
      memory: { getUserQuestion: () => 'trace' },
      storeSmResult: () => {},
    };
    const services = {
      getSession: () => session,
      getPanel: () => undefined,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      turnEpoch: () => 1,
      requireModel: () => model,
      requireGraph: () => graph,
      logAndReturn: (_tool: string, data: Record<string, unknown>) => {
        returned = data;
        return data;
      },
      buildActiveFilter: () => ({}),
      toolError: (_tool: string, error: unknown) => ({ error: 'internal_error', detail: String(error) }),
    } as unknown as ToolServices;
    return { engine, services, result: () => returned };
  }
  function setupCt() {
    const ctNodes = [
      { id: 'origin', schema: 'dbo', name: 'Origin', type: 'view', columns: [{ name: 'amount', type: 'int', nullable: 'NOT NULL', extra: '' }] },
      { id: 'base_table', schema: 'dbo', name: 'BaseTable', type: 'table', columns: [{ name: 'raw_amount', type: 'int', nullable: 'NOT NULL', extra: '' }] },
    ] as any;
    const ctModel = {
      nodes: ctNodes,
      edges: [{ source: 'base_table', target: 'origin', type: 'SELECT' }],
      schemas: ['dbo'],
      dbPlatform: 'SQL Server',
    } as any;
    const graph = makeGraph(ctNodes, [['base_table', 'origin']]);
    const engine = new NavigationEngine(ctModel, graph, () => {}, {});
    engine.init({ origin: 'origin', question: 'trace amount', direction: 'upstream', analysisMode: 'ct', targetColumns: ['amount'] });
    engine.getHopContext();
    let returned: Record<string, unknown> = {};
    const session = {
      stateMachine: engine,
      classification: 'business',
      memory: { getUserQuestion: () => 'trace amount' },
      storeSmResult: () => {},
    };
    const services = {
      getSession: () => session,
      getPanel: () => undefined,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      turnEpoch: () => 1,
      requireModel: () => ctModel,
      requireGraph: () => graph,
      logAndReturn: (_tool: string, data: Record<string, unknown>) => {
        returned = data;
        return data;
      },
      buildActiveFilter: () => ({}),
      toolError: (_tool: string, error: unknown) => ({ error: 'internal_error', detail: String(error) }),
    } as unknown as ToolServices;
    return { engine, services, result: () => returned };
  }
  it("complete full BB finding passes without repair metadata", () => {
  const { engine, services, result } = setup();
  const raw = {
    focus_node_id: 'ORIGIN',
    sections: [{ angle: 'business', text: 'Origin dispatches both paths.' }],
    summary: 'Origin dispatches both paths.',
    verdict: 'analyze',
    route_requests: [
      { nodeId: 'A', question: 'Trace A.' },
      { nodeId: 'B', question: 'Trace B.' },
    ],
  };
  executeSubmitFindings(raw, services);
  const accepted = result() as { error?: string };
  assert(accepted.error === undefined, 'complete full BB finding passes without repair metadata');
  assert(engine.toJSON().memory.detailSlots.origin !== undefined, 'accepted full finding commits authored detail');
  assertEq(raw.focus_node_id, 'ORIGIN', 'normalization does not mutate the raw focus identity');
  assertEq(raw.route_requests[0].nodeId, 'A', 'normalization does not mutate raw route identities');
});

  it("repair:true is rejected by the strict full BB boundary", () => {
  const { engine, services, result } = setup();
  const before = engine.toJSON();
  executeSubmitFindings({
    repair: true,
    focus_node_id: 'origin',
    sections: [{ angle: 'business', text: 'Repair must not be a second protocol.' }],
    summary: 'Repair must not be a second protocol.',
    verdict: 'analyze',
  }, services);
  const rejected = result() as { error?: string; hint?: string };
  assertEq(rejected.error, 'invalid_input', 'repair:true is rejected by the strict full BB boundary');
  assert(/repair/i.test(rejected.hint ?? ''), 'strict rejection identifies the unknown repair field');
  const after = engine.toJSON();
  assertEq(Object.keys(after.memory.detailSlots).length, Object.keys(before.memory.detailSlots).length, 'repair-shaped rejection commits no detail');
  assertEq(after.agenda.length, before.agenda.length, 'repair-shaped rejection commits no agenda mutation');
});

  it("BB preserves the established CT-field rejection envelope", () => {
  const { services, result } = setup();
  executeSubmitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business', text: 'Wrong mode field.' }],
    summary: 'Wrong mode field.',
    verdict: 'analyze',
    column_flow: [],
  }, services);
  assertEq((result() as { error?: string }).error, 'bb_field_unknown', 'BB preserves the established CT-field rejection envelope');
});

  it("CT preserves the established BB-field rejection envelope", () => {
  const { services, result } = setupCt();
  executeSubmitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business', text: 'Wrong mode field.' }],
    summary: 'Wrong mode field.',
    verdict: 'analyze',
    column_flow: [],
    prune_neighbors: ['base_table'],
  }, services);
  assertEq((result() as { error?: string }).error, 'bb_field_forbidden_in_ct', 'CT preserves the established BB-field rejection envelope');
});

  it("handler delegates completed-status authority to NavigationEngine", () => {
  const { engine, services, result } = setup();
  let engineCalls = 0;
  (engine as any)._status = 'complete';
  engine.submitFindings = (() => {
    engineCalls++;
    return { error: 'invalid_status', current_status: 'complete', hint: 'engine-owned status rejection' };
  }) as typeof engine.submitFindings;
  executeSubmitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business', text: 'Complete status probe.' }],
    summary: 'Complete status probe.',
    verdict: 'analyze',
  }, services);
  assertEq(engineCalls, 1, 'handler delegates completed-status authority to NavigationEngine');
  assertEq(
    JSON.stringify(result()),
    JSON.stringify({
      error: 'exploration_complete',
      hint: 'Hop loop is closed - every scope node has been analyzed and the archive is sealed. Call lineage_present_result to assemble the final report from the archive. Do not retry submit_findings.',
      next_action: 'present_result',
    }),
    'engine invalid_status=complete maps to the byte-stable exploration_complete envelope',
  );
});

  it("handler delegates focus alignment authority to NavigationEngine", () => {
  const { engine, services, result } = setup();
  let engineCalls = 0;
  engine.submitFindings = (() => {
    engineCalls++;
    return { error: 'focus_mismatch', expected: 'origin', got: 'a' };
  }) as typeof engine.submitFindings;
  executeSubmitFindings({
    focus_node_id: 'a',
    sections: [{ angle: 'business', text: 'Focus mismatch probe.' }],
    summary: 'Focus mismatch probe.',
    verdict: 'analyze',
  }, services);
  assertEq(engineCalls, 1, 'handler delegates focus alignment authority to NavigationEngine');
  assertEq(
    JSON.stringify(result()),
    JSON.stringify({
      error: 'focus_node_id_mismatch',
      expected: 'origin',
      got: 'a',
      hint: 'submit_findings.focus_node_id must match the current focus node. Expected: origin. Resubmit with the correct focus_node_id.',
    }),
    'engine focus_mismatch maps to the byte-stable focus_node_id_mismatch envelope',
  );
});

  it("real engine invalid_focus_node preserves authored casing in the byte-stable invalid_input envelope, hint now names the expected id", () => {
  const { engine, services, result } = setup();
  const before = JSON.stringify(engine.toJSON());
  executeSubmitFindings({
    focus_node_id: 'MissingCase',
    sections: [{ angle: 'business', text: 'Unknown focus probe.' }],
    summary: 'Unknown focus probe.',
    verdict: 'analyze',
  }, services);
  assertEq(
    JSON.stringify(result()),
    JSON.stringify({
      error: 'invalid_input',
      message: 'focus_node_id `MissingCase` not found in the loaded model.',
      hint: 'Retry lineage_submit_findings with the exact current-hop focus_node.id: `origin`.',
    }),
    'real engine invalid_focus_node preserves authored casing in the byte-stable invalid_input envelope, hint now names the expected id',
  );
  assertEq(JSON.stringify(engine.toJSON()), before, 'unknown focus commits zero engine state through the real handler path');
});

});
