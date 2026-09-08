/**
 * Depth derivation must not resolve silently.
 *
 * T8S-DEPTH-SILENT: two recorded baselines (`mainref-ds2-fireworks`,
 * `baseline-main-1.1.0`) carried a correctly derived `depthIntent`
 * `{kind: 'asymmetric', upstream: 2, downstream: 1}` and still ran with
 * `depthEnforcement: 'silent'`. The intent was visible in the `[BFS]` line
 * (`depth=up=2 down=1`) while the enforcement it resolved to was not logged at
 * all, so the regression read as a correctly bounded run on the log alone.
 *
 * These tests pin the OBSERVABILITY contract, never a captured answer: every
 * depth intent kind emits one record of what it resolved to — intent kind,
 * enforcement and the cap actually installed — so a bound that does not bind is
 * visible without a state dump.
 */
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import type { DepthIntent } from '../../../src/ai/sm/smTypes';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

describe('Depth derivation is recorded, never silent', () => {
  const nodes: LineageNode[] = ['n0', 'n1', 'n2', 'n3'].map(id =>
    makeNode({ id, schema: 'dbo', name: id, type: 'view' }),
  );
  const edges: Array<[string, string]> = [['n0', 'n1'], ['n1', 'n2'], ['n2', 'n3']];
  const model: DatabaseModel = makeModel(nodes, edges, ['dbo']);
  const graph = makeGraph(nodes, edges);

  /** Runs `init` with the given intent and returns every logged line. */
  function initAndCollect(depthIntent: DepthIntent): string[] {
    const lines: string[] = [];
    const engine = new NavigationEngine(model, graph, (_lvl, msg) => { lines.push(msg); }, {});
    // Bidirectional throughout: an asymmetric intent is rejected on a single
    // direction (`ASYMMETRIC_DEPTH_REQUIRES_BIDIRECTIONAL`) before any derivation runs.
    engine.init({ origin: 'n0', question: 'trace', direction: 'bidirectional', depthIntent });
    return lines;
  }

  /** The single resolution record for a derivation. */
  function resolutionLine(lines: string[]): string | undefined {
    return lines.find(l => l.startsWith('[Depth] resolved'));
  }

  const cases: Array<{ name: string; intent: DepthIntent; enforcement: string; cap: string }> = [
    {
      name: 'explicit',
      intent: { kind: 'explicit', levels: 2 },
      enforcement: 'strict',
      cap: 'up:2/down:2',
    },
    {
      name: 'asymmetric',
      intent: { kind: 'asymmetric', upstream: 2, downstream: 1 },
      enforcement: 'strict',
      cap: 'up:2/down:1',
    },
    {
      name: 'full_frontier',
      intent: { kind: 'full_frontier' },
      enforcement: 'silent',
      cap: 'up:all/down:all',
    },
    {
      name: 'default_start',
      intent: { kind: 'default_start' },
      enforcement: 'silent',
      cap: 'up:all/down:all',
    },
  ];

  for (const c of cases) {
    it(`T1-${c.name}: the resolution names the intent, the enforcement and the cap`, () => {
      const line = resolutionLine(initAndCollect(c.intent));
      expect(line, `intent '${c.name}' resolved with no [Depth] record`).toBeDefined();
      expect(line).toContain(`intent=${c.name}`);
      expect(line).toContain(`enforcement=${c.enforcement}`);
      expect(line).toContain(`cap=${c.cap}`);
    });
  }

  it('T2: exactly one resolution record per derivation', () => {
    for (const c of cases) {
      const hits = initAndCollect(c.intent).filter(l => l.startsWith('[Depth] resolved'));
      expect(hits.length, `intent '${c.name}' logged ${hits.length} resolution records`).toBe(1);
    }
  });

  it('T3: the T8S regression shape is visible on the log alone', () => {
    // The failing baselines: a user-stated asymmetric bound. A run that reports this
    // intent must also report that it binds; `enforcement=silent` here is the defect
    // signature the two baselines carried undetected.
    const line = resolutionLine(initAndCollect({ kind: 'asymmetric', upstream: 2, downstream: 1 }));
    expect(line).toBeDefined();
    expect(line).not.toContain('enforcement=silent');
  });
});
