import { readFileSync } from 'node:fs';
import { executeSubmitFindings } from '../../../src/ai/tools/handlers/submitFindings';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { ToolServices } from '../../../src/ai/tools/handlers/toolServices';
import { makeGraph } from '../helpers/testUtils';
import { describe, expect, it } from 'vitest';

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
  expect(accepted.error === undefined, 'complete full BB finding passes without repair metadata').toBe(true);
  expect(engine.toJSON().memory.detailSlots.origin !== undefined, 'accepted full finding commits authored detail').toBe(true);
  expect(raw.focus_node_id, 'normalization does not mutate the raw focus identity').toBe('ORIGIN');
  expect(raw.route_requests[0].nodeId, 'normalization does not mutate raw route identities').toBe('A');
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
  expect(rejected.error, 'repair:true is rejected by the strict full BB boundary').toBe('invalid_input');
  expect(/repair/i.test(rejected.hint ?? ''), 'strict rejection identifies the unknown repair field').toBe(true);
  const after = engine.toJSON();
  expect(Object.keys(after.memory.detailSlots).length, 'repair-shaped rejection commits no detail').toBe(Object.keys(before.memory.detailSlots).length);
  expect(after.agenda.length, 'repair-shaped rejection commits no agenda mutation').toBe(before.agenda.length);
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
  expect((result() as { error?: string }).error, 'BB preserves the established CT-field rejection envelope').toBe('bb_field_unknown');
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
  expect((result() as { error?: string }).error, 'CT preserves the established BB-field rejection envelope').toBe('bb_field_forbidden_in_ct');
});

  it("handler delegates completed-status authority to NavigationEngine", () => {
  const { engine, services, result } = setup();
  let engineCalls = 0;
  (engine as any)._status = 'complete';
  engine.submitFindings = (() => {
    engineCalls++;
    return { error: 'invalid_status', current_status: 'complete', hint: 'engine-owned status rejection' };
  });
  executeSubmitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business', text: 'Complete status probe.' }],
    summary: 'Complete status probe.',
    verdict: 'analyze',
  }, services);
  expect(engineCalls, 'handler delegates completed-status authority to NavigationEngine').toBe(1);
  expect(JSON.stringify(result()), 'engine invalid_status=complete maps to the byte-stable exploration_complete envelope').toBe(JSON.stringify({
      error: 'exploration_complete',
      hint: 'Hop loop is closed - every scope node has been analyzed and the archive is sealed. Call lineage_present_result to assemble the final report from the archive. Do not retry submit_findings.',
      next_action: 'present_result',
    }));
});

  it("handler delegates focus alignment authority to NavigationEngine", () => {
  const { engine, services, result } = setup();
  let engineCalls = 0;
  engine.submitFindings = (() => {
    engineCalls++;
    return { error: 'focus_mismatch', expected: 'origin', got: 'a' };
  });
  executeSubmitFindings({
    focus_node_id: 'a',
    sections: [{ angle: 'business', text: 'Focus mismatch probe.' }],
    summary: 'Focus mismatch probe.',
    verdict: 'analyze',
  }, services);
  expect(engineCalls, 'handler delegates focus alignment authority to NavigationEngine').toBe(1);
  expect(JSON.stringify(result()), 'engine focus_mismatch maps to the byte-stable focus_node_id_mismatch envelope').toBe(JSON.stringify({
      error: 'focus_node_id_mismatch',
      expected: 'origin',
      got: 'a',
      hint: 'submit_findings.focus_node_id must match the current focus node. Expected: origin. Resubmit with the correct focus_node_id.',
    }));
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
  expect(JSON.stringify(result()), 'real engine invalid_focus_node preserves authored casing in the byte-stable invalid_input envelope, hint now names the expected id').toBe(JSON.stringify({
      error: 'invalid_input',
      message: 'focus_node_id `MissingCase` not found in the loaded model.',
      hint: 'Retry lineage_submit_findings with the exact current-hop focus_node.id: `origin`.',
    }));
  expect(JSON.stringify(engine.toJSON()), 'unknown focus commits zero engine state through the real handler path').toBe(before);
});

  // Per-hop progress echo. The chat status trail is composed from the accepted payload's
  // `summary` and `verdict`, so both halves are pinned: the handler accepts each shape the
  // echo has to render, and the composition rule that reads them.
  it.each([
    { label: 'an analyze commit with a summary', summary: 'Not on the path.', verdict: 'analyze' as const },
    { label: 'a prune commit, which the echo marks', summary: 'Not on the path.', verdict: 'prune' as const },
    { label: 'an empty summary, which the echo skips', summary: '', verdict: 'prune' as const },
  ])('the handler accepts $label', ({ summary, verdict }) => {
  const { engine, services, result } = setup();
  executeSubmitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business', text: 'Origin dispatches both paths.' }],
    summary: 'Origin dispatches both paths.',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'a', question: 'Trace A.' }, { nodeId: 'b', question: 'Trace B.' }],
  }, services);
  expect((result() as { error?: string }).error === undefined, 'the origin hop commits').toBe(true);

  const focus = (engine.getHopContext() as { focus_node?: { id: string } }).focus_node;
  expect(focus?.id !== undefined, 'a second hop is dispatched to submit against').toBe(true);
  executeSubmitFindings({
    focus_node_id: focus!.id,
    sections: [{ angle: 'business', text: 'Nothing relevant here.' }],
    summary,
    verdict,
  }, services);
  // Length is never a rejection axis, so an empty summary commits and the echo is what skips it.
  expect((result() as { error?: string }).error === undefined, `the shape reaches the echo (got ${JSON.stringify(result())})`).toBe(true);
});

  // The echo itself lives in the agent graph's active-hop node, which has no public test seam
  // (it runs only inside a full provider turn). Its three rules are pinned at the source that
  // owns them so a silent rewrite of the trail fails here.
  it("the per-hop echo marks a prune, ticks every other verdict, and skips an empty summary", () => {
  const source = readFileSync(new URL('../../../src/ai/agent/graph.ts', import.meta.url), 'utf8');
  const echo = source.slice(source.indexOf('const verdictMark'));
  expect(source.includes("committedFinding.value && committedFinding.value.summary.trim()"), 'an empty summary produces no echo').toBe(true);
  expect(echo.includes("=== 'prune' ? '⛔ pruned' : '✓'"), 'a prune is marked, every other verdict is ticked').toBe(true);
  expect(echo.includes('${verdictMark} Hop ${hop}: ${focusLabel}'), 'the echo names the hop number and the node just finished').toBe(true);
});

});
