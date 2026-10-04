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

  it('restore owns references independently of the checkpoint supplied by the caller', () => {
    const checkpoint = structuredClone(populatedLedger().investigationTasks);
    const restored = new TaskLedger();
    restored.restore(checkpoint, []);
    const task = checkpoint[0];
    if (task.kind !== 'column_lineage') throw new Error('Expected column task');
    const refs = task.sourceRefs as Array<{ node: string; col: string }>;
    refs[0].col = 'ChangedAfterRestore';
    refs.push({ node: 'dbo.Other', col: 'Injected' });
    expect(restored.investigationTasks[0]).toMatchObject({ sourceRefs: [{ node: 'dbo.Source', col: 'Amount' }] });
  });
});
