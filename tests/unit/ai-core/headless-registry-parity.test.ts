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
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from '../sm/helpers/fixtures';

describe('headless registry parity', () => {
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
