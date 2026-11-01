// Owner: src/ai/sm/taskLedger.ts; component tests of the task ledger and its agenda hand-off.
/**
 * Component tests: TaskLedger task identity (SQL literal questions, qualified source references,
 * inherited versus assigned tasks, case sensitivity) and ownership of the references it stores,
 * with the AgendaManager it feeds. Moved out of lineage-cases-functional.test.ts, which runs whole
 * navigations.
 */
import { describe, expect, it } from 'vitest';
import { AgendaManager } from '../../../src/ai/sm/agendaManager';
import { TaskLedger } from '../../../src/ai/sm/taskLedger';

describe('TaskLedger qualified references', () => {
  it.each([false, true])(
    'retains distinct SQL literal questions through fan-in under CS=%s',
    (caseSensitive) => {
      const ledger = new TaskLedger(caseSensitive);
      const agenda = new AgendaManager(caseSensitive);
      const questions = [
        "Explain Code = 'US'",
        "Explain Code = 'us'",
        "Explain Code = 'A B'",
        "Explain Code = 'A  B'",
      ];
      const ids = questions.map((question) => {
        const task = ledger.ensureTask({
          kind: 'analytical',
          source: 'model',
          nodeId: 'focus',
          question,
          createdHop: 1,
        });
        agenda.push({
          nodeId: 'focus',
          taskIds: [task.id],
          priority: 0,
          depth: 1,
          lineageQuestions: [question],
        });
        return task.id;
      });
      expect(new Set(ids).size).toBe(questions.length);
      expect(agenda.get('focus')).toMatchObject({
        taskIds: ids,
        lineageQuestions: questions,
      });
      expect(ledger.investigationTasks.map((task) => task.question)).toEqual(
        questions,
      );
      expect(
        ledger.ensureTask({
          kind: 'analytical',
          source: 'model',
          nodeId: 'focus',
          question: questions[0],
          createdHop: 2,
        }).id,
      ).toBe(ids[0]);
    },
  );

  const task = (field: 'sourceRefs', col: string) => ({
    source: 'engine' as const,
    question: 'Trace Value',
    nodeId: 'dbo.Fn',
    kind: 'column_lineage' as const,
    activeColumns: ['Value'] as [string],
    [field]: [{ node: 'dbo.Caller', col }],
    createdHop: 1,
  });

  it('normalizes delimiters and insensitive case in sourceRefs identity', () => {
    const ledger = new TaskLedger();
    expect(ledger.ensureTask(task('sourceRefs', '[Value]')).id).toBe(
      ledger.ensureTask(task('sourceRefs', 'value')).id,
    );
  });

  it('preserves case-sensitive sourceRefs identity', () => {
    const ledger = new TaskLedger(true);
    expect(ledger.ensureTask(task('sourceRefs', 'Value')).id).not.toBe(
      ledger.ensureTask(task('sourceRefs', 'value')).id,
    );
    expect(ledger.ensureTask(task('sourceRefs', '[Value]')).id).toBe(
      ledger.ensureTask(task('sourceRefs', 'Value')).id,
    );
  });
});
