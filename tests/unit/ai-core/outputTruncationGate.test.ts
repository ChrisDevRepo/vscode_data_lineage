/**
 * Pins the output-truncation gate step: a planted cut fails, a log-helper trunc and an allowlisted
 * elision pass, and a stale baseline entry fails.
 */
import { describe, expect, it } from 'vitest';
import { compare, findSites } from '../../tools/assert-no-output-truncation.mjs';

describe('assert-no-output-truncation', () => {
  it('flags a planted slice plus ellipsis', () => {
    const sites = findSites('src/ai/x.ts', 'const s = x.slice(0, 40) + "…";\n');
    expect(sites).toHaveLength(1);
    expect(compare(sites, []).fresh).toHaveLength(1);
  });

  it('flags a cut marker literal and a cap helper name', () => {
    expect(findSites('src/ai/x.ts', "const m = '…[truncated to bound]';\n")).toHaveLength(1);
    expect(findSites('src/ai/x.ts', 'return capRejectionText(reason);\n')).toHaveLength(1);
  });

  it('passes a trunc call that flows into a log call on the same line', () => {
    expect(findSites('src/ai/x.ts', 'logger.debug(`x=${trunc(value, LOG_TRUNC_JSON)}`);\n')).toEqual([]);
  });

  it('flags a trunc call outside a log call', () => {
    expect(findSites('src/ai/x.ts', 'return { text: trunc(value, 80) };\n')).toHaveLength(1);
  });

  it('passes an allowlisted visible elision and a slice without an ellipsis', () => {
    expect(findSites('src/ai/prompting/scopeSummaryRenderer.ts', "for (const g of groups.slice(0, CARD_OBJECT_TYPE_LIMIT)) lines.push('…');\n")).toEqual([]);
    expect(findSites('src/ai/x.ts', 'const head = items.slice(0, 3);\n')).toEqual([]);
  });

  it('fails a stale baseline entry and passes a matching one', () => {
    const sites = findSites('src/ai/x.ts', 'const s = x.slice(0, 40) + "…";\n');
    const known = [{ file: 'src/ai/x.ts', text: 'const s = x.slice(0, 40) + "…";' }];
    expect(compare(sites, known)).toEqual({ fresh: [], stale: [] });
    expect(compare([], known).stale).toEqual(known);
  });
});

 it('allows only the approved committed-hop display call, retaining other graph prohibitions', () => {
   const display = "const display = truncAtWordBoundary(committedFinding.value.summary.replace(/\\s+/g, ' ').trim(), 135);";
   expect(findSites('src/ai/agent/graph.ts', display)).toEqual([]);
   expect(findSites('src/ai/agent/graph.ts', 'const memory = truncAtWordBoundary(summary, 135);')).toHaveLength(1);
   expect(findSites('src/ai/agent/graph.ts', display.replace('135', '100'))).toHaveLength(1);
 });
