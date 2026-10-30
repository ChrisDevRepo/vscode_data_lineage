/** D-098: a resent saved field is never rejected during a repair; every remaining fault is reported together. */
import { describe, expect, it } from 'vitest';
import { AiSession } from '../../../src/ai/session/session';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { executeSubmitFindings } from '../../../src/ai/tools/handlers/submitFindings';
import type { ToolServices } from '../../../src/ai/tools/handlers/toolServices';
import { makeGraph, makeIndexedModel, makeNode } from '../helpers/modelFixtures';

describe('submit_findings repair keeps resent saved fields (D-098)', () => {
  const held = (classification: 'technical' | 'both' = 'technical', seedSummary = true) => {
    const logs: string[] = [];
    const node = makeNode({ id: '[dbo].[Report]', schema: 'dbo', name: 'Report', type: 'view', bodyScript: 'SELECT 1 AS Value;' });
    const model = makeIndexedModel([node], []);
    const session = new AiSession();
    const epoch = session.beginTurn();
    session.model = model;
    session.classification = classification;
    const engine = new NavigationEngine(model, makeGraph([node], []), (_level, line) => logs.push(line), { memory: session.memory });
    session.stateMachine = engine;
    expect(engine.init({ origin: node.id, question: 'Explain Report.', direction: 'upstream', analysisMode: 'bb', depthIntent: { upstream: { levels: 1, exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } } })).toHaveProperty('ok', true);
    engine.classification = classification;
    engine.getHopContext();
    const services = { getSession: () => session, turnEpoch: () => epoch, requireModel: () => model,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      logAndReturn: (_name: string, data: object) => JSON.stringify(data),
      toolError: (_name: string, error: unknown) => { throw error; },
    } as unknown as ToolServices;
    const summary = 'Report returns a constant Value.';
    if (seedSummary) {
      const first = JSON.parse(executeSubmitFindings({ focus_node_id: node.id, summary }, services));
      expect(first.errors).toEqual([{ path: 'sections', code: 'missing' }]);
      expect(engine.heldPartsOfCurrentFocus()?.resend).not.toContain('summary');
    }
    return { node, engine, services, summary, logs, session };
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
    expect(result.errors).toContainEqual({ path: 'summary', code: 'not_overwritten' });
    expect(engine.getDetailSlots()).toEqual([]);
    expect(JSON.parse(executeSubmitFindings({ sections: { technical: 'Corrected section.' } }, services))).toHaveProperty('ok', true);
    expect(engine.getDetailSlots()).toContainEqual(expect.objectContaining({ summary }));
  });

  it('D-103: null withdraws an optional badge while a required summary null remains a faulty overwrite', () => {
    const { engine, services, summary } = held();
    expect(JSON.parse(executeSubmitFindings({ badge_label: 'Held badge' }, services))).toHaveProperty('code', 'invalid_input');
    const rejected = JSON.parse(executeSubmitFindings({ summary: null, badge_label: null,
      sections: { technical: 'Value is the literal 1.' } }, services));
    expect(rejected).toMatchObject({ code: 'invalid_input', issuePaths: ['summary'] });
    expect(rejected.errors).toEqual(expect.arrayContaining([
      { path: 'summary', code: 'type', values: ['string'] }, { path: 'summary', code: 'not_overwritten' },
    ]));
    expect(JSON.parse(executeSubmitFindings({}, services))).toHaveProperty('ok', true);
    expect(engine.getDetailSlots()).toContainEqual(expect.objectContaining({ summary,
      sections: [{ angle: 'technical', text: 'Value is the literal 1.' }] }));
    expect(engine.getDetailSlots()[0]?.badge_label).toBeUndefined();
  });

  it.each([false, true])('requires a current summary while retaining archived section content (held=%s)', withHeld => {
    const { engine, services, node, session } = held('technical', false);
    const sections = [{ angle: 'technical' as const, text: 'Previously captured SQL evidence.' }];
    session.memory.storeDetail(node, sections, 'Earlier visit summary.');
    const summary = 'Updated summary for this visit.';
    if (withHeld) expect(JSON.parse(executeSubmitFindings({ summary, badge_label: 42 }, services))).toHaveProperty('code', 'invalid_input');
    else {
      const missing = JSON.parse(executeSubmitFindings({}, services));
      expect(missing.errors).toContainEqual({ path: 'summary', code: 'missing' });
      expect(session.memory.getArchivedAngles(node.id)).toEqual(new Set(['technical']));
    }
    const nullSummary = JSON.parse(executeSubmitFindings({ summary: null }, services));
    expect(nullSummary.errors).toContainEqual({ path: 'summary', code: 'type', values: ['string'] });
    if (withHeld) expect(nullSummary.errors).toContainEqual({ path: 'summary', code: 'not_overwritten' });
    expect(JSON.parse(executeSubmitFindings(withHeld ? {} : { summary }, services))).toHaveProperty('ok', true);
    expect(engine.getDetailSlots()).toContainEqual(expect.objectContaining({ summary, sections }));
  });

  it('D-101/D-102: a resent sections object replaces whole and a faulty replacement retains its held copy', () => {
    const { engine, services } = held('both');
    const sections = { business: 'Held business.', technical: 'Held technical.' };
    expect(JSON.parse(executeSubmitFindings({ sections, badge_label: 'x'.repeat(51) }, services))).toHaveProperty('code', 'invalid_input');
    const rejected = JSON.parse(executeSubmitFindings({ sections: { technical: 'Changed technical.' }, badge_label: 'Short' }, services));
    expect(rejected).toHaveProperty('code', 'invalid_input');
    expect(rejected.errors).toContainEqual({ path: 'sections', code: 'not_overwritten' });
    expect(rejected.errors).toContainEqual(expect.objectContaining({ path: 'sections.business', code: 'missing' }));
    expect(JSON.parse(executeSubmitFindings({}, services))).toHaveProperty('ok', true);
    expect(engine.getDetailSlots()[0]?.sections).toEqual([
      { angle: 'business', text: sections.business }, { angle: 'technical', text: sections.technical },
    ]);
    const replacement = held('both');
    expect(JSON.parse(executeSubmitFindings({ sections, badge_label: 'x'.repeat(51) }, replacement.services))).toHaveProperty('code', 'invalid_input');
    expect(JSON.parse(executeSubmitFindings({ sections: { technical: 'Changed technical.' }, badge_label: 'Short' }, replacement.services))).toHaveProperty('code', 'invalid_input');
    expect(JSON.parse(executeSubmitFindings({ badge_label: 'Short', sections: { business: 'New business.', technical: 'New technical.' } }, replacement.services))).toHaveProperty('ok', true);
    expect(replacement.engine.getDetailSlots()).toContainEqual(expect.objectContaining({ sections: [
      { angle: 'business', text: 'New business.' }, { angle: 'technical', text: 'New technical.' },
    ] }));
  });

  it('D-098: an identical saved-field resend is logged as a no-op and still reports the owed section', () => {
    const { services, summary, logs } = held();
    const result = JSON.parse(executeSubmitFindings({ summary }, services));
    expect(result.errors).toContainEqual(expect.objectContaining({ path: 'sections', code: 'missing' }));
    expect(logs.some(line => line.includes('identical resend no-op'))).toBe(true);
    expect(JSON.parse(executeSubmitFindings({ sections: { technical: 'Corrected section.' } }, services))).toHaveProperty('ok', true);
  });

});
