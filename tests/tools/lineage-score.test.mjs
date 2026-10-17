import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { changedCount, commandCounts, comparePairSets, compareRunPair, compareSequences, durationBand, escalationCount, scoreCandidate, sizeRag, tokenBand } from './lineage-score.mjs';
import { previewCharCount } from './trace-metrics.mjs';

describe('lineage score', () => {
  it('treats visit order as a regression and the same column pairs in another order as a signal', () => {
    expectSequence();
    const reordered = comparePairSets(
      [{ from_node: 'a', from_col: 'id', to_node: 'b', to_col: 'id' }, { from_node: 'b', from_col: 'id', to_node: 'c', to_col: 'id' }],
      [{ from_node: 'b', from_col: 'id', to_node: 'c', to_col: 'id' }, { from_node: 'a', from_col: 'id', to_node: 'b', to_col: 'id' }],
    );
    assert.equal(reordered.regression, false);
    assert.equal(reordered.signal, 'order_only');
    const lost = comparePairSets(
      [{ from_node: 'a', from_col: 'id', to_node: 'b', to_col: 'id' }],
      [],
    );
    assert.deepEqual(lost.lost, ['a|id|b|id']);
    assert.equal(lost.regression, true);
  });

  it('keeps a different fixture out of the graph regression and bands preview length', () => {
    const root = mkdtempSync(join(tmpdir(), 'dlv-score-'));
    try {
      const base = join(root, 'base');
      const cand = join(root, 'cand');
      writeTurn(base, 'turn-1', { visited: ['a', 'b'], edges: [{ from_node: 'a', from_col: 'id', to_node: 'b', to_col: 'id' }] }, 'baseline preview text');
      writeTurn(cand, 'turn-1', { visited: ['b', 'a'], edges: [] }, 'short');
      writeFileSync(join(base, 'run.json'), JSON.stringify({ turns: [{ questionHash: 'q', fixtureHash: 'same' }] }));
      writeFileSync(join(cand, 'run.json'), JSON.stringify({ turns: [{ questionHash: 'q', fixtureHash: 'same' }] }));
      const matched = compareRunPair(cand, base);
      assert.equal(matched.turns[0].identity, 'matched');
      assert.ok(matched.regressions.some(item => item.label === 'visited'));
      assert.ok(matched.regressions.some(item => item.label === 'columnAspect'));
      assert.equal(sizeRag(100, 40).rag, 'RED');
      assert.equal(sizeRag(100, 90).rag, 'GREEN');
      assert.equal(sizeRag(100, 70).rag, 'AMBER');
      writeFileSync(join(cand, 'run.json'), JSON.stringify({ turns: [{ questionHash: 'q', fixtureHash: 'other' }] }));
      const excluded = compareRunPair(cand, base);
      assert.equal(excluded.turns[0].graph.status, 'excluded');
      assert.deepEqual(excluded.regressions, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('counts the canonical preview instead of the streamed answer', () => {
    const root = mkdtempSync(join(tmpdir(), 'dlv-preview-'));
    try {
      const turn = join(root, 'turn-1');
      mkdirSync(turn);
      writeFileSync(join(turn, 'answer.md'), 'short');
      writeFileSync(join(turn, 'present-result.json'), JSON.stringify({ aiMetadata: { description: 'canonical preview' } }));
      const onlyAnswer = join(root, 'turn-2');
      mkdirSync(onlyAnswer);
      writeFileSync(join(onlyAnswer, 'answer.md'), 'streamed');
      assert.equal(previewCharCount(root), 'canonical preview'.length + 'streamed'.length);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('counts prune and supplement calls and keeps preview length apart from the chat window', () => {
  assert.deepEqual(commandCounts([
    { type: 'wire-response', toolCalls: [
      { name: 'lineage_prune_current', input: { focus_node_id: 'a' } },
      { name: 'lineage_start_exploration', input: { origin: 'a', supplement: { nodeIds: ['b'] } } },
      { name: 'lineage_start_exploration', input: { origin: 'a' } },
    ] },
    { type: 'tool', toolName: 'lineage_prune_current' },
  ]), { prune: 1, add: 1 });
  assert.equal(escalationCount([{ resolved: true, rejections: 1 }, { resolved: true, rejections: 2 }, { resolved: false, rejections: 1 }]), 2);
  assert.equal(tokenBand(100, 115).rag, 'GREEN');
  assert.equal(tokenBand(100, 116).regression, true);
  assert.equal(durationBand(1000, 1200).rag, 'GREEN');
  assert.equal(durationBand(1000, 3001).rag, 'RED');
  const root = mkdtempSync(join(tmpdir(), 'dlv-facts-'));
  try {
    const base = join(root, 'base');
    const cand = join(root, 'cand');
    writeTurn(base, 'turn-1', { visited: ['a'], edges: [] }, '```sql\nselect 1\n```\n$$x$$');
    writeTurn(cand, 'turn-1', { visited: ['a'], edges: [] }, 'prose');
    writeFileSync(join(base, 'turn-1', 'answer.md'), 'chat-baseline');
    writeFileSync(join(cand, 'turn-1', 'answer.md'), 'chat');
    writeFileSync(join(base, 'run.json'), JSON.stringify({ turns: [{ questionHash: 'q', fixtureHash: 'same' }] }));
    writeFileSync(join(cand, 'run.json'), JSON.stringify({ turns: [{ questionHash: 'q', fixtureHash: 'same' }] }));
    const matched = compareRunPair(cand, base);
    assert.ok(matched.regressions.some(item => item.label === 'sqlFences'));
    assert.ok(matched.regressions.some(item => item.label === 'formula'));
    assert.equal(matched.turns[0].text.preview.baseline, '```sql\nselect 1\n```\n$$x$$'.length);
    assert.equal(matched.turns[0].text.chat.baseline, 'chat-baseline'.length);
    const trace = '{"type":"turn-terminal","requestId":"r","status":"ok"}\n';
    for (const dir of [base, cand]) {
      mkdirSync(join(dir, 'lm-trace'));
      writeFileSync(join(dir, 'lm-trace', 'trace.ndjson'), dir === cand
        ? `${trace.slice(0, -1).replace('"ok"', '"error"')}\n`
        : trace);
    }
    const report = scoreCandidate(cand, [{ name: 'previous', dir: base }], join(root, 'out'));
    assert.equal(report.operationalDefects, true);
    assert.equal(JSON.stringify(report).includes('case-scorecard'), false);
    assert.equal(changedCount(1, 1).regression, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  });
});

function expectSequence() {
  assert.equal(compareSequences(['a', 'b'], ['b', 'a']).regression, true);
  assert.equal(compareSequences(['a'], ['a']).regression, false);
  assert.equal(compareSequences(null, null).status, 'absent');
}

function writeTurn(runDir, name, state, description) {
  const turn = join(runDir, name);
  mkdirSync(turn, { recursive: true });
  writeFileSync(join(turn, 'sm-state.json'), JSON.stringify({
    visited: state.visited,
    agenda: state.visited.map(nodeId => ({ nodeId })),
    columnAspect: { edges: state.edges },
  }));
  writeFileSync(join(turn, 'final-snapshot.json'), JSON.stringify({ nodes: state.visited, columnEdges: state.edges }));
  writeFileSync(join(turn, 'present-result.json'), JSON.stringify({ aiMetadata: { description } }));
}
