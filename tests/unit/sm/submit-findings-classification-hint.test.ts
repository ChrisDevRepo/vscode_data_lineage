import { executeSubmitFindings } from '../../../src/ai/tools/handlers/submitFindings';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { ToolServices } from '../../../src/ai/tools/handlers/toolServices';
import { makeGraph } from '../helpers/testUtils';
import { describe, expect, it } from 'vitest';

// Reproduces test-results/e2e/m0-zai-1-zai/run-T8 (glm-5.3-flash, hop 3, focus
// [ai].[sploadsalesstaging]): under classification="both", a submission carrying only an
// angle="business" section was rejected as `classification_lock_violation` with a hint that
// restated the requirement ('classification=both requires sections with angle="business" and
// angle="technical".') but never named which angle the submission already held or what edit
// would fix it. The model repeated the identical business-only submission on its very next
// retry (in between, a different malformed retry dropped `sections` entirely and failed
// `invalid_tool_input`) — three chargeable failures tripped the semantic-failure breaker and
// ended the run at 3 of 23 scope nodes. The handler-level envelope is the failing layer: the
// pure rule (`validateSectionsAgainstClassification`) already returns non-null correctly, so a
// unit test against that rule alone would stay green through this production failure.
describe("Submit Findings classification-lock hint names the repair", () => {
  const nodes = [
    { id: 'origin', schema: 'dbo', name: 'Origin', type: 'view' },
    { id: 'a', schema: 'dbo', name: 'A', type: 'view' },
  ] as any;
  const model = {
    nodes,
    edges: [{ source: 'origin', target: 'a', type: 'SELECT' }],
    schemas: ['dbo'],
    dbPlatform: 'SQL Server',
  } as any;
  function setupBoth() {
    const graph = makeGraph(nodes, [['origin', 'a']]);
    const engine = new NavigationEngine(model, graph, () => {}, {});
    engine.init({ origin: 'origin', question: 'trace', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 1 } });
    engine.getHopContext();
    let returned: Record<string, unknown> = {};
    const session = {
      stateMachine: engine,
      classification: 'both',
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

  it("names the present angle, the missing angle, and the add-not-replace edit", () => {
    const { services, result } = setupBoth();
    executeSubmitFindings({
      focus_node_id: 'origin',
      sections: [{ angle: 'business', text: 'Business-only content, as the failing run submitted.' }],
      summary: 'Business-only content.',
      verdict: 'analyze',
    }, services);
    const rejected = result() as { error?: string; hint?: string };
    expect(rejected.error, 'a both-classification, business-only submission is rejected').toBe('classification_lock_violation');
    const hint = rejected.hint ?? '';
    expect(hint.includes('classification=both'), 'hint still names the locked classification').toBe(true);
    expect(/present|included|already/i.test(hint) && hint.includes('angle="business"'), 'hint names the angle already present').toBe(true);
    expect(/add/i.test(hint) && hint.includes('angle="technical"'), 'hint names the missing angle and the add edit').toBe(true);
    expect(/keep|do not remove|do not replace/i.test(hint), 'hint tells the model to keep the existing section rather than drop it').toBe(true);
  });

  it("names the present angle when only technical is submitted", () => {
    const { services, result } = setupBoth();
    executeSubmitFindings({
      focus_node_id: 'origin',
      sections: [{ angle: 'technical', text: 'Technical-only content.' }],
      summary: 'Technical-only content.',
      verdict: 'analyze',
    }, services);
    const rejected = result() as { error?: string; hint?: string };
    expect(rejected.error).toBe('classification_lock_violation');
    const hint = rejected.hint ?? '';
    expect(hint.includes('angle="technical"') && /present|included|already/i.test(hint), 'hint names technical as present').toBe(true);
    expect(hint.includes('angle="business"') && /add/i.test(hint), 'hint names business as the missing, addable angle').toBe(true);
  });
});
