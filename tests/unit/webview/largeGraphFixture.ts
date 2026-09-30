/**
 * Deterministic large-graph generator for the rendering lanes.
 *
 * The largest tracked fixture is 148 nodes (tests/fixtures/graph-baseline-aw.json), so nothing above
 * ~150 objects had ever been executed. `maxNodes` admits 2000 objects and `renderLimit` renders up
 * to 1500, which leaves the whole range a real warehouse lands in untested. `buildLargeModel` is a
 * thin wrapper over the shared seeded DWH generator ({@link generateDwhModel} in
 * `tests/unit/helpers/dwhGraphGenerator.ts`), fixed to `nodeCount` real objects and zero external
 * refs, so a failure is reproducible from the node count alone and the shape stays a single source
 * of truth across every large-graph test consumer.
 */

import type { DatabaseModel } from '../../../src/engine/types';
import { generateDwhModel } from '../helpers/dwhGraphGenerator';

const FIXED_SEED = 20260923;

/**
 * Builds a lineage model of exactly `nodeCount` objects with a deterministic, realistic
 * data-warehouse dependency shape (schema skew, hubs, hot spots, isolated objects and islands).
 *
 * @param nodeCount - Number of objects to generate.
 * @returns A model with nodes, edges, schemas, catalog, and neighbor index fully populated.
 */
export function buildLargeModel(nodeCount: number): DatabaseModel {
  return generateDwhModel({ objectCount: nodeCount, seed: FIXED_SEED, profile: { externalRefCount: 0 } }).model;
}
