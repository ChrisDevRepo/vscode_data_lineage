import { describe, expect, it } from 'vitest';
import { TaskLedger } from '../../../src/ai/sm/taskLedger';

function populatedLedger(): TaskLedger {
  const ledger = new TaskLedger();
  ledger.ensureTask({ source: 'engine', question: 'Trace Amount', nodeId: 'dbo.Target', kind: 'column_lineage', activeColumns: ['Amount'], sourceRefs: [{ node: 'dbo.Source', col: 'Amount' }], createdHop: 1 });
  return ledger;
}

describe('TaskLedger sourceRefs ownership', () => {
  it('returned task snapshots cannot mutate live source references', () => {
    const ledger = populatedLedger();
    const snapshot = ledger.investigationTasks[0];
    if (snapshot.kind !== 'column_lineage') throw new Error('Expected column task');
    const refs = snapshot.sourceRefs as Array<{ node: string; col: string }>;
    refs[0].col = 'ChangedOutsideLedger';
    refs.push({ node: 'dbo.Other', col: 'Injected' });
    expect(ledger.investigationTasks[0]).toMatchObject({ sourceRefs: [{ node: 'dbo.Source', col: 'Amount' }] });
  });

  it('ensureTask owns references independently of the input supplied by the caller', () => {
    const input = structuredClone(populatedLedger().investigationTasks[0]);
    if (input.kind !== 'column_lineage') throw new Error('Expected column task');
    const { id: _id, ...taskInput } = input;
    const ledger = new TaskLedger();
    ledger.ensureTask(taskInput);
    const refs = input.sourceRefs as Array<{ node: string; col: string }>;
    refs[0].col = 'ChangedAfterEnsure';
    refs.push({ node: 'dbo.Other', col: 'Injected' });
    expect(ledger.investigationTasks[0]).toMatchObject({ sourceRefs: [{ node: 'dbo.Source', col: 'Amount' }] });
  });
});

describe('TaskLedger qualified column identity', () => {
  const task = (field: 'sourceRefs' | 'returnTargets', col: string) => ({ source: 'engine' as const, question: 'Trace Value', nodeId: 'dbo.Fn',
    kind: 'column_lineage' as const, activeColumns: ['Value'] as [string], [field]: [{ node: 'dbo.Caller', col }], createdHop: 1 });

  it.each(['sourceRefs', 'returnTargets'] as const)('keys %s columns by the same delimiter-blind normalization', field => {
    const ledger = new TaskLedger();
    expect(ledger.ensureTask(task(field, '[Value]')).id).toBe(ledger.ensureTask(task(field, 'value')).id);
  });

  it.each(['sourceRefs', 'returnTargets'] as const)('keeps case-distinct %s columns apart under a case-sensitive source', field => {
    const ledger = new TaskLedger(true);
    expect(ledger.ensureTask(task(field, 'Value')).id).not.toBe(ledger.ensureTask(task(field, 'value')).id);
    expect(ledger.ensureTask(task(field, '[Value]')).id).toBe(ledger.ensureTask(task(field, 'Value')).id);
  });
});
