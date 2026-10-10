/** A rejected finding keeps every valid entry: the retry resends only the entry that failed. */
import { describe, expect, it } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { HopFindingKept } from '../../../src/ai/sm/smTypes';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';

const origin = '[dbo].[origin]', writer = '[dbo].[writer]', other = '[dbo].[other]', far = '[dbo].[far]';

function setup(classification?: 'technical' | 'both') {
  const nodes = ['origin', 'writer', 'other', 'far'].map(name => makeNode({
    id: `[dbo].[${name}]`, name, schema: 'dbo', type: 'procedure',
  }));
  const pairs: Array<[string, string]> = [[writer, origin], [other, origin], [far, writer]];
  const engine = new NavigationEngine(makeModel(nodes, pairs, ['dbo']), makeGraph(nodes, pairs), () => {}, {});
  if (classification) engine.classification = classification;
  expect(engine.init({
    origin, question: 'Investigate upstream writers', direction: 'upstream',
    depthIntent: { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } },
  })).toMatchObject({ ok: true });
  expect(engine.getHopContext().focus_node?.id).toBe(origin);
  return engine;
}

const kept: HopFindingKept = {
  focus_node_id: origin, verdict: 'analyze', summary: 'Origin reads both writers.',
  sections: [{ angle: 'technical', text: 'Origin SQL detail.' }],
};
/** A correction retry that names nothing it does not change. */
const bare = { focus_node_id: origin, verdict: 'analyze' as const, summary: '', sections: [] };

function committed(engine: NavigationEngine) {
  const state = engine.toJSON();
  return { hop: state.hopCount, agenda: state.agenda, removed: state.removedSet, visited: state.visited, nodes: state.nodeStates, tasks: engine.investigationTasks };
}

function questionFor(engine: NavigationEngine, nodeId: string): string[] {
  return engine.investigationTasks.filter(task => task.nodeId === nodeId && task.source === 'model').map(task => task.question);
}

describe('item-level repair of a rejected submit_findings', () => {
  it('indexes repeated rejected retries against the resent questions without losing held work', () => {
    const engine = setup();
    const before = committed(engine);
    engine.holdRejectedSubmission({ ...kept, sections: { technical: 'Origin SQL detail.' }, questions: [{ nodeId: writer, question: 'Inspect writer' }] }, ['badge_label']);
    for (let attempt = 0; attempt < 2; attempt++) {
      const rejected = engine.submitFindings({ ...bare, questions: [{ nodeId: far, question: 'Inspect far' }] });
      expect(rejected).toMatchObject({ code: 'route_validation_failed', issuePaths: ['questions.0.nodeId'] });
      if (!('code' in rejected)) throw new Error('expected a rejection');
      expect(rejected.detail).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'questions.0.nodeId' })]));
      expect(committed(engine)).toEqual(before);
      const held = engine.applyHeldContent(bare);
      expect(held).toMatchObject({ questions: [{ nodeId: writer, question: 'Inspect writer' }] });
    }
    expect(engine.submitFindings({ ...bare, questions: [{ nodeId: other, question: 'Inspect other' }] })).toMatchObject({ ok: true });
    expect(engine.investigationTasks.filter(task => task.source === 'model').map(task => task.question)).toEqual(['Inspect writer', 'Inspect other']);
  });

  it('indexes both sides of a resent conflict independently of held neighbor entries', () => {
    const engine = setup();
    const before = committed(engine);
    engine.holdRejectedSubmission({ ...kept, sections: { technical: 'Origin SQL detail.' },
      questions: [{ nodeId: other, question: 'Inspect other' }],
      prune_neighbors: [{ id: far, reason: 'Not needed' }],
    }, ['badge_label']);
    const rejected = engine.submitFindings({ ...bare,
      questions: [{ nodeId: writer, question: 'Inspect writer' }],
      prune_neighbors: [{ id: writer, reason: 'Not needed' }],
    });
    expect(rejected).toMatchObject({ code: 'route_validation_failed', issuePaths: ['questions.0.nodeId', 'prune_neighbors.0.id'] });
    expect(committed(engine)).toEqual(before);
    expect(engine.applyHeldContent(bare)).toMatchObject({
      questions: [{ nodeId: other, question: 'Inspect other' }],
      prune_neighbors: [{ id: far, reason: 'Not needed' }],
    });
  });

  it('keeps the valid questions entries when one entry names a non-neighbor', () => {
    const engine = setup();
    const before = committed(engine);
    const rejected = engine.submitFindings({ ...kept, questions: [
      { nodeId: writer, question: 'How does writer load the rows?' },
      { nodeId: far, question: 'Is far relevant?' },
    ] });
    expect(rejected).toMatchObject({ code: 'route_validation_failed', issuePaths: ['questions.1.nodeId'] });
    if (!('code' in rejected)) throw new Error('expected a rejection');
    expect(rejected.hint).toContain(`questions (${writer})`);
    expect(committed(engine)).toEqual(before);

    const repaired = engine.applyHeldContent(bare);
    if ('code' in repaired) throw new Error(repaired.reason);
    expect(repaired.questions).toEqual([{ nodeId: writer, question: 'How does writer load the rows?' }]);
    expect(engine.submitFindings(repaired)).toMatchObject({ ok: true });
    expect(questionFor(engine, writer)).toEqual(['How does writer load the rows?']);
  });

  it('merges a resent corrected entry with the held entries instead of replacing them', () => {
    const engine = setup();
    expect(engine.submitFindings({ ...kept, questions: [
      { nodeId: writer, question: 'How does writer load the rows?' },
      { nodeId: far, question: 'Is far relevant?' },
    ] })).toMatchObject({ code: 'route_validation_failed' });
    const repaired = engine.applyHeldContent({ ...bare, questions: [{ nodeId: other, question: 'What does other add?' }] });
    if ('code' in repaired) throw new Error(repaired.reason);
    expect(repaired.questions).toEqual([
      { nodeId: writer, question: 'How does writer load the rows?' },
      { nodeId: other, question: 'What does other add?' },
    ]);
    expect(engine.submitFindings(repaired)).toMatchObject({ ok: true });
    expect(questionFor(engine, writer)).toEqual(['How does writer load the rows?']);
    expect(questionFor(engine, other)).toEqual(['What does other add?']);
  });

  it('drops only the conflicting entries of a prune/question conflict and keeps unrelated prunes', () => {
    const engine = setup();
    const rejected = engine.submitFindings({ ...kept,
      prune_neighbors: [{ id: other, reason: 'Off the answer' }, { id: writer, reason: 'Unsure' }],
      questions: [{ nodeId: writer, question: 'How does writer load the rows?' }],
    });
    expect(rejected).toMatchObject({ code: 'route_validation_failed' });
    if (!('code' in rejected)) throw new Error('expected a rejection');
    expect(rejected.issuePaths).toEqual(['questions.0.nodeId', 'prune_neighbors.1.id']);
    const repaired = engine.applyHeldContent({ ...bare, questions: [{ nodeId: writer, question: 'How does writer load the rows?' }] });
    if ('code' in repaired) throw new Error(repaired.reason);
    expect(repaired.prune_neighbors).toEqual([{ id: other, reason: 'Off the answer' }]);
    expect(engine.submitFindings(repaired)).toMatchObject({ ok: true });
    expect(engine.toJSON().removedSet).toContain(other);
    expect(engine.toJSON().removedSet).not.toContain(writer);
  });

  it('lets a resent prune replace a held question for the same neighbor', () => {
    const engine = setup();
    expect(engine.submitFindings({ ...kept, questions: [
      { nodeId: writer, question: 'How does writer load the rows?' },
      { nodeId: far, question: 'Is far relevant?' },
    ] })).toMatchObject({ code: 'route_validation_failed' });
    const repaired = engine.applyHeldContent({ ...bare, prune_neighbors: [{ id: writer, reason: 'Off the answer after all' }] });
    if ('code' in repaired) throw new Error(repaired.reason);
    expect(repaired.questions ?? []).toEqual([]);
    expect(engine.submitFindings(repaired)).toMatchObject({ ok: true });
    expect(engine.toJSON().removedSet).toContain(writer);
  });

  it('holds the valid entries of a schema-rejected questions list', () => {
    const engine = setup();
    const held = engine.holdRejectedSubmission({
      focus_node_id: origin, verdict: 'analyze', summary: kept.summary, sections: { technical: 'Origin SQL detail.' },
      questions: [{ nodeId: writer, question: 'How does writer load the rows?' }, { nodeId: other, question: 42 }, 'junk'],
    }, ['questions.1.question', 'questions.2']);
    expect(held).toEqual({ sections: ['technical'], summary: true, fields: ['questions'], entries: { questions: [writer] } });
    const repaired = engine.applyHeldContent(bare);
    if ('code' in repaired) throw new Error(repaired.reason);
    expect(repaired.questions).toEqual([{ nodeId: writer, question: 'How does writer load the rows?' }]);
  });

  it('fails a whole list when an issue names the list itself, never holding a malformed entry', () => {
    const engine = setup();
    const held = engine.holdRejectedSubmission({
      focus_node_id: origin, verdict: 'analyze', summary: kept.summary, sections: { technical: 'Origin SQL detail.' },
      questions: [{ nodeId: writer, question: 'How does writer load the rows?' }, { nodeId: other }],
    }, ['questions', 'questions.1.question']);
    expect(held).toEqual({ sections: ['technical'], summary: true, fields: [] });
    const repaired = engine.applyHeldContent(bare);
    if ('code' in repaired) throw new Error(repaired.reason);
    expect(repaired.questions).toBeUndefined();
  });

  it('holds the valid section angle when only the other angle failed its schema', () => {
    const engine = setup('both');
    const held = engine.holdRejectedSubmission({
      focus_node_id: origin, verdict: 'analyze', summary: kept.summary,
      sections: { business: 'Business meaning.', technical: 42 },
    }, ['sections.technical']);
    expect(held).toMatchObject({ sections: ['business'], summary: true });
    const repaired = engine.applyHeldContent({ ...bare, sections: [{ angle: 'technical', text: 'Fixed technical detail.' }] });
    if ('code' in repaired) throw new Error(repaired.reason);
    expect(repaired.sections).toEqual([
      { angle: 'business', text: 'Business meaning.' },
      { angle: 'technical', text: 'Fixed technical detail.' },
    ]);
    expect(engine.submitFindings(repaired)).toMatchObject({ ok: true });
  });

  it('holds the angle a retry adds when the lock still misses another angle', () => {
    const engine = setup('both');
    expect(engine.holdRejectedSubmission({
      focus_node_id: origin, verdict: 'analyze', summary: kept.summary, sections: { business: 7, technical: 7 },
    }, ['sections.business', 'sections.technical'])).toMatchObject({ sections: [], summary: true });
    const first = engine.submitFindings({ ...bare, sections: [{ angle: 'business', text: 'Business meaning.' }] });
    expect(first).toMatchObject({ code: 'invalid_input', issuePaths: ['sections'] });
    if (!('code' in first)) throw new Error('expected a rejection');
    expect(first.hint).toContain('sections (business)');
    expect(engine.submitFindings({ ...bare, sections: [{ angle: 'technical', text: 'Technical detail.' }] })).toMatchObject({ ok: true });
    expect(engine.getDetailSlots()).toContainEqual(expect.objectContaining({ nodeId: origin, sections: [
      { angle: 'business', text: 'Business meaning.' }, { angle: 'technical', text: 'Technical detail.' },
    ] }));
  });

  it('round-trips a held item-level draft through the engine snapshot', () => {
    const engine = setup();
    expect(engine.submitFindings({ ...kept, questions: [
      { nodeId: writer, question: 'How does writer load the rows?' },
      { nodeId: far, question: 'Is far relevant?' },
    ] })).toMatchObject({ code: 'route_validation_failed' });
    const snapshot = engine.toJSON();
    expect(snapshot.engineInternals?.heldFinding).toMatchObject({ failed: [], finding: { questions: [{ nodeId: writer }] } });
  });
});
