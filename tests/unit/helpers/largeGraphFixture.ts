/** Deterministic large-graph fixture shared by backend correctness and optional layout checks. */

import type { DatabaseModel } from '../../../src/engine/types';
import { generateDwhModel } from './dwhGraphGenerator';

const FIXED_SEED = 20260923;

/** Builds a lineage model of exactly `nodeCount` objects with a deterministic, realistic data-warehouse dependency shape (schema skew, hubs, hot spots, isolated objects and islands). */
export function buildLargeModel(nodeCount: number): DatabaseModel {
  return generateDwhModel({ objectCount: nodeCount, seed: FIXED_SEED, profile: { externalRefCount: 0 } }).model;
}
