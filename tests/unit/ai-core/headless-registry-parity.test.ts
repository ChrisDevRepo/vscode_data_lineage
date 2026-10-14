/** Headless tools receive the runtime model, its admission budget and lease cancellation for discovery handoff. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AiSession } from '../../../src/ai/session/session';
import { createTurnTokenBudget } from '../../../src/ai/support/tokenBudget';
import { runHarnessTurn } from '../../harness/runTurn';
import { createHeadlessLogger } from '../../harness/headlessLogger';
import { ScriptedModelPort, validCall } from '../../harness/scriptedModelPort';
import { makeGraph, makeModel, makeNode } from '../helpers/modelFixtures';
import { modelUserMessage, modelAssistantMessage } from '../../../src/ai/model/modelPort';
import { LineageRuntime } from '../../../src/ai/runtime/lineageRuntime';

describe('headless registry parity', () => {
  it.each([
    { label: 'absent history', history: false, prompt: 'Which filter affects this column?', expected: 'Which filter affects this column?' },
    { label: 'provided history', history: true, prompt: 'Which filter affects this column?', expected: 'Which filter affects this column?' },
    { label: 'native participant mention', history: false, prompt: '@lineage /trace [dbo].[A].[Amount]', expected: '/trace [dbo].[A].[Amount]' },
    { label: 'caller SQL', history: false, prompt: '@lineage /trace [dbo].[A].[Amount]\nSELECT x FROM dbo.fn(@p);\n', expected: '/trace [dbo].[A].[Amount]\nSELECT x FROM dbo.fn(@p);\n' },
    { label: 'SQL indentation', history: false, prompt: '@lineage  SELECT x FROM dbo.A', expected: ' SELECT x FROM dbo.A' },
    { label: 'mention in SQL', history: false, prompt: "SELECT '@lineage' AS Label FROM dbo.A", expected: "SELECT '@lineage' AS Label FROM dbo.A" },
    { label: 'other participant name', history: false, prompt: '@lineageOther /trace A', expected: '@lineageOther /trace A' },
  ])('forwards $label through the native request boundary', async ({ history, prompt, expected }) => {
    const runDir = mkdtempSync(join(tmpdir(), 'lineage-history-'));
    try {
      const nodes = [makeNode({ id: 'A', name: 'A', schema: 'dbo', type: 'view' })];
      const session = new AiSession();
      session.model = makeModel(nodes, [], ['dbo']);
      session.graph = makeGraph(nodes, []);
      const priorMessages = history
        ? [modelUserMessage('Inspect A.Amount'), modelAssistantMessage('A.Amount comes from B.Cost.')]
        : undefined;
      const model = new ScriptedModelPort([{ text: 'Synthetic boundary reply.' }]);
      const run = vi.spyOn(LineageRuntime.prototype, 'run').mockResolvedValue({ outcome: 'ok', modelCalls: 0 });
      await runHarnessTurn({ session, model, prompt, runDir,
        logger: createHeadlessLogger('test', join(runDir, 'host.log')), priorMessages,
      });
      expect(run.mock.calls[0][0].request.priorMessages).toBe(priorMessages);
      expect(run.mock.calls[0][0].request.prompt).toBe(expected);
    } finally {
      vi.restoreAllMocks();
      rmSync(runDir, { recursive: true, force: true });
    }
  });
  it.each(['handoff', 'cancel', 'budget'] as const)('uses the selected model for %s', async scenario => {
    const runDir = mkdtempSync(join(tmpdir(), 'lineage-registry-'));
    try {
      const nodes = (scenario === 'budget' ? ['A', 'B'] : ['A']).map(id => makeNode({ id, name: id, schema: 'dbo', type: 'view' }));
      const pairs: Array<[string, string]> = scenario === 'budget' ? [['A', 'B']] : [];
      const session = new AiSession();
      session.model = makeModel(nodes, pairs, ['dbo']);
      session.graph = makeGraph(nodes, pairs);
      session.lastDiscoveryQuestion = 'What does A calculate?';
      session.lastDiscoveryAnswer = 'A contains the synthetic calculation.';
      const model = new ScriptedModelPort([
        { toolCalls: [validCall('start', 'lineage_start_exploration', {
          origin: 'A', analysisMode: 'bb', classification: 'technical',
          depth: { upstream: { levels: 0, exactness: 'exact' }, downstream: { levels: 'all', exactness: 'exact' } },
        })] },
        { text: 'The requested scope exceeds this turn\'s round limit.' },
      ], ['Synthetic handoff memo.'], [], createTurnTokenBudget({ maxRounds: 1 }));
      const controller = new AbortController();
      const completeText = vi.spyOn(model, 'completeText');
      if (scenario === 'cancel') completeText.mockImplementation(async () => {
        controller.abort();
        throw new DOMException('Synthetic abort', 'AbortError');
      });
      const result = await runHarnessTurn({ session, model, prompt: '/trace A', runDir,
        logger: createHeadlessLogger('test', join(runDir, 'host.log')), signal: controller.signal,
        gate: [{ kind: 'deny' }],
      });
      expect(result.outcome.outcome, readFileSync(join(runDir, 'host.log'), 'utf8')).not.toBe('error');
      if (scenario === 'budget') {
        expect(result.gates).toHaveLength(0);
        expect(completeText).not.toHaveBeenCalled();
        expect(readFileSync(join(runDir, 'host.log'), 'utf8')).toContain('code=over_active_scope_budget');
      } else {
        expect(completeText.mock.calls.length, readFileSync(join(runDir, 'host.log'), 'utf8')).toBe(1);
        expect(completeText.mock.calls[0][0].signal).toBe(controller.signal);
        if (scenario === 'cancel') {
          expect(result.outcome.outcome).toBe('cancelled');
          expect(result.gates).toHaveLength(0);
        } else {
          expect(result.gates).toHaveLength(1);
          expect(result.events).toContainEqual(expect.objectContaining({ type: 'gate', summary: expect.stringContaining('Synthetic handoff memo.') }));
        }
      }
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});
