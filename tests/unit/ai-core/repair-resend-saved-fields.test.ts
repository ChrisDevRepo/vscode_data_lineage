/** D-098: a resent saved field is never rejected during a repair; every remaining fault is reported together. */
import { describe, expect, it } from 'vitest';
import { AiSession } from '../../../src/ai/session/session';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { executeSubmitFindings } from '../../../src/ai/tools/handlers/submitFindings';
import type { ToolServices } from '../../../src/ai/tools/handlers/toolServices';
import { makeGraph, makeIndexedModel, makeNode } from '../helpers/modelFixtures';

describe('submit_findings repair keeps resent saved fields (D-098)', () => {
  const held = () => {
    const node = makeNode({ id: '[dbo].[Report]', schema: 'dbo', name: 'Report', type: 'view', bodyScript: 'SELECT 1 AS Value;' });
    const model = makeIndexedModel([node], []);
    const session = new AiSession();
    const epoch = session.beginTurn();
    session.model = model;
    session.classification = 'technical';
    const engine = new NavigationEngine(model, makeGraph([node], []), () => {}, { memory: session.memory });
    session.stateMachine = engine;
    expect(engine.init({ origin: node.id, question: 'Explain Report.', direction: 'upstream', analysisMode: 'bb', depthIntent: { upstream: { levels: 1, exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } } })).toHaveProperty('ok', true);
    engine.classification = 'technical';
    engine.getHopContext();
    const services = { getSession: () => session, turnEpoch: () => epoch, requireModel: () => model,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      logAndReturn: (_name: string, data: object) => JSON.stringify(data),
      toolError: (_name: string, error: unknown) => { throw error; },
    } as unknown as ToolServices;
    const summary = 'Report returns a constant Value.';
    const first = JSON.parse(executeSubmitFindings({ focus_node_id: node.id, summary }, services));
    expect(first.missingParts).toEqual(['sections']);
    expect(engine.heldPartsOfCurrentFocus()?.resend).not.toContain('summary');
    return { node, engine, services, summary };
  };

  it('accepts the held summary resent unchanged with the owed section', () => {
    const { node, engine, services, summary } = held();
    const result = JSON.parse(executeSubmitFindings({ focus_node_id: node.id, summary, sections: { technical: 'Value is the SQL literal 1.' } }, services));
    expect(result).not.toHaveProperty('code');
    expect(engine.heldFindingFocus).toBeNull();
  });

  it('replaces a held summary resent changed', () => {
    const { node, engine, services } = held();
    const changed = 'Report returns the literal Value 1.';
    const result = JSON.parse(executeSubmitFindings({ focus_node_id: node.id, summary: changed, sections: { technical: 'Value is the SQL literal 1.' } }, services));
    expect(result).not.toHaveProperty('code');
    expect(JSON.stringify(engine.toJSON())).toContain(changed);
  });

  it('reports a faulty resent saved field together with the still-owed field', () => {
    const { node, engine, services, summary } = held();
    const result = JSON.parse(executeSubmitFindings({ focus_node_id: node.id, summary: 42, sections: { technical: 42 } }, services));
    expect(result.code).toBe('invalid_input');
    expect(result.issuePaths).toEqual(expect.arrayContaining(['summary', 'sections.technical']));
    expect(JSON.stringify(result)).not.toContain('Unrecognized key');
    expect(engine.heldPartsOfCurrentFocus()).toMatchObject({ summary: true });
    expect(JSON.stringify(engine.toJSON())).toContain(summary);
  });
});
