/**
 * A question forwarded through a non-bodied node keeps its authored text on the task; the
 * passthrough re-anchor sentence is stored beside it, rendered for the receiving hop only, and never
 * archived as an incoming question for synthesis.
 */
import { describe, expect, it } from 'vitest';
import { buildCurrentTaskBlock } from '../../../src/ai/prompting/prompts';
import { buildPassthroughReAnchor } from '../../../src/ai/prompting/smPrompts';
import { parseNavigationSnapshot } from '../../../src/ai/sm/navigationSnapshotSchema';
import type { NavigationEngine } from '../../../src/ai/sm/smBase';
import { TaskLedger, taskPromptText } from '../../../src/ai/sm/taskLedger';
import { world, type DepthSide } from './helpers/bbShapes';

const CLOSED: DepthSide = { levels: 0, exactness: 'exact' };
const ALL: DepthSide = { levels: 'all', exactness: 'approximate' };
const QUESTION = 'How is Amount computed before it lands in t?';
const RE_ANCHOR = buildPassthroughReAnchor('t', 'p', 'bb');

/** `p` writes table `t`, origin view `j` reads it: a question to `t` contracts onto `p`. */
function throughTable(): NavigationEngine {
  const { engine } = world({ p: 'procedure', t: 'table', j: 'view' }, [['p', 't'], ['t', 'j']], 'j', ALL, CLOSED);
  expect(engine.getHopContext().focus_node?.id).toBe('j');
  expect(engine.submitFindings({
    focus_node_id: 'j', verdict: 'analyze', summary: 'j reads t',
    sections: [{ angle: 'technical', text: 'SELECT Amount FROM t' }],
    questions: [{ nodeId: 't', question: QUESTION }],
  })).toMatchObject({ ok: true });
  expect(engine.getHopContext().focus_node?.id).toBe('p');
  return engine;
}

function forwardedTask(engine: NavigationEngine) {
  const task = engine.investigationTasks.find(entry => entry.nodeId === 'p');
  expect(task).toBeDefined();
  return task!;
}

describe('passthrough re-anchor storage', () => {
  it('stores the forwarded question as authored and the re-anchor as its own field', () => {
    const task = forwardedTask(throughTable());
    expect(task.question).toBe(QUESTION);
    expect(task.reAnchor).toBe(RE_ANCHOR);
    expect(task.question).not.toContain('Inherited through passthrough');
  });

  it('renders the question and the re-anchor in the receiving hop\'s current task as one sub-question', () => {
    const engine = throughTable();
    const block = buildCurrentTaskBlock(engine.getCurrentTasks());
    expect(block).toContain(`<sub_question>${QUESTION}\n(Inherited through passthrough t; re-anchor this question to p.`);
    expect(block).toBe(buildCurrentTaskBlock([{ kind: 'analytical', question: `${QUESTION}\n${RE_ANCHOR}` }]));
  });

  it('archives only the authored question as the incoming question synthesis receives', () => {
    const engine = throughTable();
    expect(engine.submitFindings({
      focus_node_id: 'p', verdict: 'analyze', summary: 'p computes Amount',
      sections: [{ angle: 'technical', text: 'INSERT INTO t SELECT ...' }],
    })).toMatchObject({ ok: true });
    expect(engine.getHopContext().done).toBe(true);
    const slot = engine.getResult().detail_slots.find(entry => entry.nodeId === 'p');
    expect(slot?.incoming_questions).toEqual([{ question: QUESTION, from_node: 'j' }]);
    expect(JSON.stringify(engine.getResult())).not.toContain('Inherited through passthrough');
  });

  it('renders a blank forwarded question as the re-anchor alone', () => {
    expect(taskPromptText({ question: '', reAnchor: 'R' })).toBe('R');
    expect(taskPromptText({ question: 'Q' })).toBe('Q');
    expect(buildCurrentTaskBlock([{ kind: 'analytical', question: ' ', reAnchor: 'R' }])).toBe('<current_task>\n  <sub_question>R</sub_question>\n</current_task>');
  });

  it('keeps tasks that differ only by re-anchor distinct', () => {
    const ledger = new TaskLedger();
    const base = { kind: 'analytical' as const, source: 'model' as const, question: 'Q', nodeId: 'p', createdHop: 1 };
    const plain = ledger.ensureTask(base);
    const viaT = ledger.ensureTask({ ...base, reAnchor: buildPassthroughReAnchor('t', 'p', 'bb') });
    const viaU = ledger.ensureTask({ ...base, reAnchor: buildPassthroughReAnchor('u', 'p', 'bb') });
    expect(new Set([plain.id, viaT.id, viaU.id]).size).toBe(3);
    expect(plain).not.toHaveProperty('reAnchor');
    expect(ledger.ensureTask({ ...base, reAnchor: viaT.reAnchor }).id).toBe(viaT.id);
  });
});

describe('navigation snapshot with the re-anchor field', () => {
  it('round-trips a task that carries a re-anchor', () => {
    const snapshot = JSON.parse(JSON.stringify(throughTable().toJSON()));
    const parsed = parseNavigationSnapshot(snapshot);
    const task = parsed.engineInternals.investigationTasks.find(entry => entry.nodeId === 'p');
    expect(task).toMatchObject({ question: QUESTION, reAnchor: RE_ANCHOR });
  });

  it('round-trips a task without a re-anchor and omits the field', () => {
    const parsed = parseNavigationSnapshot(JSON.parse(JSON.stringify(throughTable().toJSON())));
    const root = parsed.engineInternals.investigationTasks.find(entry => entry.kind === 'root');
    expect(root).toBeDefined();
    expect(root).not.toHaveProperty('reAnchor');
  });

  it('loads an older snapshot whose question still ends with the suffix, without rewriting it', () => {
    const snapshot = JSON.parse(JSON.stringify(throughTable().toJSON()));
    const legacyQuestion = `${QUESTION}\n${RE_ANCHOR}`;
    for (const task of snapshot.engineInternals.investigationTasks) {
      if (task.nodeId !== 'p') continue;
      delete task.reAnchor;
      task.question = legacyQuestion;
    }
    const parsed = parseNavigationSnapshot(snapshot);
    const task = parsed.engineInternals.investigationTasks.find(entry => entry.nodeId === 'p');
    expect(task?.question).toBe(legacyQuestion);
    expect(task).not.toHaveProperty('reAnchor');
  });

  it('rejects a blank re-anchor', () => {
    const snapshot = JSON.parse(JSON.stringify(throughTable().toJSON()));
    const task = snapshot.engineInternals.investigationTasks.find((entry: { nodeId?: string }) => entry.nodeId === 'p');
    task.reAnchor = '';
    expect(() => parseNavigationSnapshot(snapshot)).toThrow();
  });
});
