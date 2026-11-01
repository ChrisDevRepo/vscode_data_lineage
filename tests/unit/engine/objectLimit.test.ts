/**
 * Pins the `dataLineageViz.maxNodes` contract: a selection at or below the limit keeps every object
 * and edge; a selection over it is refused outright with the exact count, limit and message, never
 * cut short; search still sees objects the canvas does not draw.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { extractDacpac } from '../../../src/engine/dacpacExtractor';
import {
  checkObjectLimit,
  formatObjectLimitMessage,
} from '../../../src/engine/modelFilters';
import { filterSuggestions } from '../../../src/utils/autocomplete';
import { buildLargeModel } from '../helpers/largeGraphFixture';
import { loadParseRules } from '../helpers/testUtils';
import {
  buildSyntheticDacpac,
  type SyntheticDacpacResult,
} from '../helpers/syntheticDacpac';

const MAX_NODES = 2000;

beforeAll(() => {
  loadParseRules();
});

function expectedEdgeCount(gt: SyntheticDacpacResult): number {
  return gt.edgeCount + gt.externalRefCount;
}

describe('formatObjectLimitMessage', () => {
  it('renders the refusal text naming the setting', () => {
    expect(formatObjectLimitMessage(2001, 2000)).toBe(
      '2,001 objects selected (limit 2,000, set by dataLineageViz.maxNodes). Select fewer schemas or raise the setting.',
    );
  });
});

describe('checkObjectLimit', () => {
  it.each([
    [2000, true],
    [2001, false],
  ])('a %i-object model against limit 2000 is admitted: %s', (count, ok) => {
    const model = { nodes: new Array(count).fill(0), edges: [] } as never;
    expect(checkObjectLimit(model, 2000)).toEqual(
      ok ? { ok, model } : { ok, count, limit: 2000 },
    );
  });
});

describe('DACPAC extraction at the object-count boundary', () => {
  it.each([1999, 2000])(
    'at/below the limit (%i objects): every object and edge is kept, nothing refused',
    async (objectCount) => {
      const gt = await buildSyntheticDacpac({ objectCount, schemaCount: 4 });
      const model = await extractDacpac(gt.buffer, undefined, undefined, {
        externalRefsEnabled: true,
      });

      expect(model.nodes).toHaveLength(gt.totalNodeCount);
      expect(model.edges).toHaveLength(expectedEdgeCount(gt));

      for (const [schema, count] of Object.entries(gt.perSchemaObjectCount)) {
        expect(model.nodes.filter((n) => n.schema === schema)).toHaveLength(
          count,
        );
      }

      expect(checkObjectLimit(model, MAX_NODES)).toEqual({ ok: true, model });
    },
  );

  it('over the limit (2001 objects): the model still holds every object — the check refuses it, extraction never truncates', async () => {
    const gt = await buildSyntheticDacpac({
      objectCount: 2001,
      schemaCount: 4,
    });
    const model = await extractDacpac(gt.buffer, undefined, undefined, {
      externalRefsEnabled: true,
    });

    expect(
      model.nodes,
      "extraction itself never truncates — that is the refused check's job, not the builder's",
    ).toHaveLength(gt.totalNodeCount);

    const check = checkObjectLimit(model, MAX_NODES);
    expect(check).toEqual({ ok: false, count: 2001, limit: MAX_NODES });
  });
});

describe('5,000-object maximum', () => {
  const MAX_NODES_CEILING = 5000;
  const RENDER_LIMIT_MAX = 1500;
  const model = buildLargeModel(MAX_NODES_CEILING);

  it('admits the model at maxNodes 5000 and refuses it at 4999 with the shared message', () => {
    expect(model.nodes).toHaveLength(MAX_NODES_CEILING);
    expect(checkObjectLimit(model, MAX_NODES_CEILING)).toEqual({
      ok: true,
      model,
    });

    const refused = checkObjectLimit(model, MAX_NODES_CEILING - 1);
    expect(refused).toEqual({
      ok: false,
      count: MAX_NODES_CEILING,
      limit: MAX_NODES_CEILING - 1,
    });
    expect(
      formatObjectLimitMessage(MAX_NODES_CEILING, MAX_NODES_CEILING - 1),
    ).toBe(
      '5,000 objects selected (limit 4,999, set by dataLineageViz.maxNodes). Select fewer schemas or raise the setting.',
    );

    const over = buildLargeModel(MAX_NODES_CEILING + 1);
    expect(checkObjectLimit(over, MAX_NODES_CEILING)).toEqual({
      ok: false,
      count: MAX_NODES_CEILING + 1,
      limit: MAX_NODES_CEILING,
    });
    expect(
      formatObjectLimitMessage(MAX_NODES_CEILING + 1, MAX_NODES_CEILING),
    ).toBe(
      '5,001 objects selected (limit 5,000, set by dataLineageViz.maxNodes). Select fewer schemas or raise the setting.',
    );
  });

  it('search finds an object the canvas does not draw', () => {
    const target = model.nodes[MAX_NODES_CEILING - 1];
    const hits = filterSuggestions(model.nodes, target.name, 50);
    expect(hits.map((n) => n.id)).toContain(target.id);
    expect(model.nodes.indexOf(target)).toBeGreaterThanOrEqual(
      RENDER_LIMIT_MAX,
    );
  });
});
