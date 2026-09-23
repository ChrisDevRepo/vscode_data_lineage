/**
 * Pins the `dataLineageViz.maxNodes` contract at scale: a selection at or below the limit keeps
 * every object, edge, and external reference; a selection over it is refused outright — the exact
 * count, the exact limit, and the exact refusal message — with no partial model ever produced.
 * `1,990 objects + 20 external references` is the regression proof for the removed virtual-node
 * admission budget: before the fix, `createVirtualNodes` silently capped external references at
 * `maxNodes - realNodeCount`, so this exact combination used to build a deceptively "at limit"
 * 2,000-node model instead of the 2,010-node model it actually represents.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { extractDacpac, extractDacpacFiltered, extractSchemaPreview, filterBySchemas } from '../../../src/engine/dacpacExtractor';
import { checkObjectLimit, formatObjectLimitMessage } from '../../../src/engine/modelFilters';
import { loadParseRules } from '../helpers/testUtils';
import { buildSyntheticDacpac, type SyntheticDacpacResult } from '../helpers/syntheticDacpac';

const MAX_NODES = 2000;

beforeAll(() => { loadParseRules(); });

function expectedEdgeCount(gt: SyntheticDacpacResult): number {
  return gt.edgeCount + gt.externalRefCount;
}

describe('formatObjectLimitMessage', () => {
  it('renders the refusal text naming the setting', () => {
    expect(formatObjectLimitMessage(2001, 2000)).toBe(
      '2,001 objects selected (limit 2,000). '
      + 'Select fewer schemas, or raise the limit in Settings: dataLineageViz.maxNodes.',
    );
  });

  it('stays within the status banner body length for a seven-digit count, so the setting name is never truncated', () => {
    expect(formatObjectLimitMessage(1234567, 2000).length).toBeLessThanOrEqual(120);
  });

  it('formats the count with toLocaleString at larger scale', () => {
    expect(formatObjectLimitMessage(12345, 2000)).toBe(
      '12,345 objects selected (limit 2,000). '
      + 'Select fewer schemas, or raise the limit in Settings: dataLineageViz.maxNodes.',
    );
  });
});

describe('checkObjectLimit', () => {
  it('admits a model at exactly the limit', () => {
    const model = { nodes: new Array(2000).fill(0), edges: [] } as never;
    const result = checkObjectLimit(model, 2000);
    expect(result).toEqual({ ok: true, model });
  });

  it('refuses a model one object over the limit', () => {
    const model = { nodes: new Array(2001).fill(0), edges: [] } as never;
    const result = checkObjectLimit(model, 2000);
    expect(result).toEqual({ ok: false, count: 2001, limit: 2000 });
  });
});

describe('DACPAC extraction at the object-count boundary', () => {
  it.each([1999, 2000])('at/below the limit (%i objects): every object and edge is kept, nothing refused', async (objectCount) => {
    const gt = await buildSyntheticDacpac({ objectCount, schemaCount: 4 });
    const model = await extractDacpac(gt.buffer, undefined, undefined, { externalRefsEnabled: true });

    expect(model.nodes).toHaveLength(gt.totalNodeCount);
    expect(model.edges).toHaveLength(expectedEdgeCount(gt));

    for (const [schema, count] of Object.entries(gt.perSchemaObjectCount)) {
      expect(model.nodes.filter(n => n.schema === schema)).toHaveLength(count);
    }

    const check = checkObjectLimit(model, MAX_NODES);
    expect(check.ok, `expected ${gt.totalNodeCount} objects to be admitted at the ${MAX_NODES} limit`).toBe(true);
  });

  it('over the limit (2001 objects): the model still holds every object — the check refuses it, extraction never truncates', async () => {
    const gt = await buildSyntheticDacpac({ objectCount: 2001, schemaCount: 4 });
    const model = await extractDacpac(gt.buffer, undefined, undefined, { externalRefsEnabled: true });

    expect(model.nodes, 'extraction itself never truncates — that is the refused check\'s job, not the builder\'s').toHaveLength(gt.totalNodeCount);

    const check = checkObjectLimit(model, MAX_NODES);
    expect(check).toEqual({ ok: false, count: 2001, limit: MAX_NODES });
    expect(formatObjectLimitMessage(2001, MAX_NODES)).toBe(
      '2,001 objects selected (limit 2,000). '
      + 'Select fewer schemas, or raise the limit in Settings: dataLineageViz.maxNodes.',
    );
  });

  it('1,990 objects + 20 external references: every reference is created (no silent budget), pushing the total over the limit', async () => {
    const gt = await buildSyntheticDacpac({ objectCount: 1990, schemaCount: 4, externalRefCount: 20 });
    const model = await extractDacpac(gt.buffer, undefined, undefined, { externalRefsEnabled: true });

    const externalNodes = model.nodes.filter(n => n.type === 'external' && n.externalType === 'file');
    expect(externalNodes, 'every one of the 20 distinct external references became a node — not just the first 10 a budget would have allowed').toHaveLength(20);
    expect(model.nodes).toHaveLength(2010);

    const check = checkObjectLimit(model, MAX_NODES);
    expect(check).toEqual({ ok: false, count: 2010, limit: MAX_NODES });
  });

  it('1,980 objects + 20 external references land exactly at the limit and are admitted', async () => {
    const gt = await buildSyntheticDacpac({ objectCount: 1980, schemaCount: 4, externalRefCount: 20 });
    const model = await extractDacpac(gt.buffer, undefined, undefined, { externalRefsEnabled: true });

    expect(model.nodes).toHaveLength(2000);
    const externalNodes = model.nodes.filter(n => n.type === 'external' && n.externalType === 'file');
    expect(externalNodes).toHaveLength(20);

    const check = checkObjectLimit(model, MAX_NODES);
    expect(check.ok).toBe(true);
  });

  it('extractDacpacFiltered (Phase 2 path) matches extractDacpac on the same boundary', async () => {
    const gt = await buildSyntheticDacpac({ objectCount: 1990, schemaCount: 4, externalRefCount: 20 });
    const { elements, dspName } = await extractSchemaPreview(gt.buffer);
    const allSchemas = new Set(gt.schemaNames);

    const model = extractDacpacFiltered(elements, allSchemas, dspName, undefined, undefined, { externalRefsEnabled: true });
    expect(model.nodes).toHaveLength(2010);
    expect(checkObjectLimit(model, MAX_NODES)).toEqual({ ok: false, count: 2010, limit: MAX_NODES });
  });
});

describe('working-graph build: filterBySchemas never trims, checkObjectLimit is the only gate', () => {
  it.each([500, 1000, 1999])('regression guard — a %i-object model keeps exactly that many nodes after the schema filter', async (objectCount) => {
    const gt = await buildSyntheticDacpac({ objectCount, schemaCount: 5 });
    const model = await extractDacpac(gt.buffer, undefined, undefined, { externalRefsEnabled: true });

    const filtered = filterBySchemas(model, new Set(gt.schemaNames));
    expect(filtered.nodes, 'filterBySchemas must never silently drop objects — that is checkObjectLimit\'s job').toHaveLength(gt.objectCount);
    expect(checkObjectLimit(filtered, MAX_NODES).ok).toBe(true);
  });

  it('a schema subset below the limit is unaffected even when the full model would exceed it', async () => {
    const gt = await buildSyntheticDacpac({ objectCount: 2001, schemaCount: 3 });
    const model = await extractDacpac(gt.buffer, undefined, undefined, { externalRefsEnabled: true });

    const oneSchema = new Set([gt.schemaNames[0]]);
    const filtered = filterBySchemas(model, oneSchema);
    expect(filtered.nodes).toHaveLength(gt.perSchemaObjectCount[gt.schemaNames[0]]);
    expect(checkObjectLimit(filtered, MAX_NODES).ok).toBe(true);
  });
});
