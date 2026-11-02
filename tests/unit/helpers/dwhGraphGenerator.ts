/**
 * Seeded, deterministic generator of an asymmetric lineage graph — the single generator every
 * large-graph test consumer builds on, tracked and gitignored alike.
 */

import type {
  CatalogEntry,
  DatabaseModel,
  LineageEdge,
  LineageNode,
  NeighborIndex,
  ObjectType,
  SchemaInfo,
} from '../../../src/engine/shared/types';

type Rng = () => number;

/** mulberry32 — a small, fast, seeded PRNG returning a deterministic `[0, 1)` stream. */
function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rngInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function shuffle<T>(rng: Rng, arr: readonly T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function cap(word: string): string {
  return word.length === 0 ? word : word[0].toUpperCase() + word.slice(1);
}

const SCHEMA_BASE = [
  'dbo',
  'stg',
  'ods',
  'dim',
  'fact',
  'mart',
  'rpt',
  'sec',
  'ext',
  'arch',
  'sandbox',
  'ref',
];
const ENTITY_WORDS = [
  'customer',
  'order',
  'product',
  'invoice',
  'shipment',
  'employee',
  'vendor',
  'payment',
  'inventory',
  'account',
  'ledger',
  'region',
  'store',
  'channel',
  'ticket',
  'contract',
];
const PROC_VERBS = ['Load', 'Refresh', 'Sync', 'Merge', 'Process', 'Build'];
const TYPE_PREFIX: Record<Exclude<ObjectType, 'external'>, string> = {
  table: 'Tbl',
  view: 'Vw',
  procedure: 'Usp',
  function: 'Fn',
};

/** Tuning knobs layered on top of the default asymmetric shape. */
interface DwhProfile {
  /** Exact schema count; default scales with `objectCount`. */
  schemaCount?: number;
  /**
   * Exact count of objects (procedures, taken from the tail) that carry an external file reference.
   */
  externalRefCount?: number;
}

/** Parameters for {@link generateDwhModel}. */
export interface GenerateDwhModelParams {
  /** Total count of real (tracked) objects — tables, views, procedures, functions. */
  objectCount: number;
  /**
   * Seed driving every random choice; same `(objectCount, seed, profile)` always yields the same
   * model.
   */
  seed: number;
  /** Asymmetry tuning; omit for the default profile. */
  profile?: DwhProfile;
}

/** Result of {@link generateDwhModel}. */
export interface GenerateDwhModelResult {
  model: DatabaseModel;
  /** Ids of the designated hub objects. */
  hubIds: string[];
}

interface GenObj {
  schema: string;
  type: ObjectType;
  name: string;
  fullName: string;
  id: string;
  isExternalCarrier: boolean;
  externalUrl?: string;
  isHub: boolean;
  isIsolated: boolean;
  /**
   * Loose 0-4 layer used only to bias edges toward a mostly-forward direction (see
   * {@link generateEdges}).
   */
  layer: number;
}

function buildSchemaNames(count: number): string[] {
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    names.push(
      i < SCHEMA_BASE.length
        ? SCHEMA_BASE[i]
        : `${SCHEMA_BASE[i % SCHEMA_BASE.length]}${Math.floor(i / SCHEMA_BASE.length)}`,
    );
  }
  return names;
}

/** Uneven (harmonic-weighted) size split of `objectCount` objects across `schemaNames`. */
function assignSchemaSizes(
  schemaNames: string[],
  objectCount: number,
): number[] {
  const weights = schemaNames.map((_, i) => 1 / (i + 1));
  const wSum = weights.reduce((a, b) => a + b, 0);
  const sizes = weights.map((w) =>
    Math.max(1, Math.round((w / wSum) * objectCount)),
  );
  const diff = objectCount - sizes.reduce((a, b) => a + b, 0);
  sizes[0] = Math.max(1, sizes[0] + diff);
  return sizes;
}

function randType(rng: Rng): ObjectType {
  const r = rng();
  if (r < 0.5) return 'table';
  if (r < 0.8) return 'view';
  if (r < 0.95) return 'procedure';
  return 'function';
}

function nameForObject(rng: Rng, type: ObjectType, seq: number): string {
  const entity = pick(rng, ENTITY_WORDS);
  if (type === 'procedure')
    return `${TYPE_PREFIX.procedure}${pick(rng, PROC_VERBS)}${cap(entity)}_${seq}`;
  return `${TYPE_PREFIX[type as Exclude<ObjectType, 'external'>]}${cap(entity)}_${seq}`;
}

const EXTERNAL_REF_HOST = 'https://synthetic.blob.core.windows.net/dwh';

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++)
    h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

function buildObjects(
  rng: Rng,
  schemaNames: string[],
  sizes: number[],
  externalRefCount: number,
): GenObj[] {
  const objs: GenObj[] = [];
  let seq = 0;
  for (let s = 0; s < schemaNames.length; s++) {
    for (let i = 0; i < sizes[s]; i++, seq++) {
      const type = randType(rng);
      const name = nameForObject(rng, type, seq);
      const fullName = `[${schemaNames[s]}].[${name}]`;
      objs.push({
        schema: schemaNames[s],
        type,
        name,
        fullName,
        id: fullName.toLowerCase(),
        isExternalCarrier: false,
        isHub: false,
        isIsolated: false,
        layer: rngInt(rng, 0, 4),
      });
    }
  }

  if (externalRefCount > 0) {
    const start = Math.max(0, objs.length - externalRefCount);
    for (let i = start; i < objs.length; i++) {
      const o = objs[i];
      o.type = 'procedure';
      o.name = `UspLoadExternal_${i}`;
      o.fullName = `[${o.schema}].[${o.name}]`;
      o.id = o.fullName.toLowerCase();
      o.isExternalCarrier = true;
      o.externalUrl = `${EXTERNAL_REF_HOST}/ext${i}.csv`;
    }
  }

  return objs;
}

/** Fraction of edges forced across a schema boundary. */
const CROSS_SCHEMA_SHARE = 0.45;
/** Extra partners per hub, independent of graph size. */
const HUB_PARTNERS = 25;

/**
 * Directed edge set: roughly `round(objectCount * edgesPerNodeTarget)` edges from uniform random
 * pairs, rejection-sampled (never filtering the full eligible pool — cheap at any N) toward a
 * schema-crossing pair per `CROSS_SCHEMA_SHARE`, and — strictly, `source.layer <= target.layer` —
 * toward the loose 0-4 layer order. Layer-monotonic edges keep the graph a near-DAG instead of
 * densely cyclic: `dagre`'s default ranker (network-simplex) is cheap on a near-DAG and
 * pathologically slow once feedback edges are common, so this is a performance property, not just a
 * realism one.
 */
function generateEdges(
  rng: Rng,
  eligible: GenObj[],
  edgeCount: number,
): LineageEdge[] {
  const edgeSet = new Set<string>();
  const edges: LineageEdge[] = [];
  if (eligible.length < 2) return edges;

  const tryAdd = (source: GenObj, target: GenObj): boolean => {
    if (source.id === target.id) return false;
    const key = `${source.id}->${target.id}`;
    if (edgeSet.has(key)) return false;
    edgeSet.add(key);
    edges.push({ source: source.id, target: target.id, type: 'body' });
    return true;
  };

  for (let i = 0; i < edgeCount; i++) {
    let added = false;
    for (let attempt = 0; attempt < 8 && !added; attempt++) {
      const target = pick(rng, eligible);
      const source = pick(rng, eligible);
      if (source.layer > target.layer) continue;
      const crossOk =
        attempt >= 6 ||
        (source.schema !== target.schema) === rng() < CROSS_SCHEMA_SHARE;
      if (!crossOk) continue;
      added = tryAdd(source, target);
    }
  }
  return edges;
}

/**
 * Bounded, N-independent extra in/out-degree for each designated hub, so a handful of objects read
 * as clearly busier than average without their degree scaling with the graph size. Direction
 * follows the same layer-monotonic rule as {@link generateEdges}, to stay a near-DAG.
 */
function addHubEdges(
  rng: Rng,
  eligible: GenObj[],
  hubs: GenObj[],
): LineageEdge[] {
  const extra: LineageEdge[] = [];

  for (const hub of hubs) {
    const partners = shuffle(
      rng,
      eligible.filter((o) => o.id !== hub.id),
    ).slice(0, HUB_PARTNERS);
    for (const p of partners) {
      const [source, target] = p.layer <= hub.layer ? [p, hub] : [hub, p];
      extra.push({ source: source.id, target: target.id, type: 'body' });
    }
  }
  return extra;
}

function emptyTypeCounts(): Record<ObjectType, number> {
  return { table: 0, view: 0, procedure: 0, function: 0, external: 0 };
}

/** Generates a seeded, deterministic, asymmetric lineage model. */
export function generateDwhModel(
  params: GenerateDwhModelParams,
): GenerateDwhModelResult {
  const { objectCount, seed, profile = {} } = params;
  if (objectCount < 1) throw new Error('objectCount must be at least 1');
  const externalRefCount = clamp(
    profile.externalRefCount ?? Math.round(objectCount * 0.02),
    0,
    objectCount,
  );

  const rng = mulberry32(seed);
  const schemaCount = clamp(
    profile.schemaCount ?? Math.max(3, Math.round(objectCount / 60)),
    2,
    60,
  );
  const schemaNames = buildSchemaNames(schemaCount);
  const sizes = assignSchemaSizes(schemaNames, objectCount);
  const objs = buildObjects(rng, schemaNames, sizes, externalRefCount);

  const nonExternal = objs.filter((o) => !o.isExternalCarrier);
  const hubCount = clamp(Math.round(objectCount * 0.001) + 2, 2, 6);
  const hubs = shuffle(rng, nonExternal).slice(
    0,
    Math.min(hubCount, nonExternal.length),
  );
  const hubIds = new Set(hubs.map((h) => h.id));
  for (const h of hubs) h.isHub = true;

  const isolatedRate = 0.07;
  for (const o of nonExternal) {
    if (!hubIds.has(o.id) && rng() < isolatedRate) o.isIsolated = true;
  }

  const eligible = nonExternal.filter((o) => !o.isIsolated);
  const edgesPerNodeTarget = 2.5 + rng() * 1.0;
  const edgeCount = Math.round(objectCount * edgesPerNodeTarget);
  const baseEdges = generateEdges(rng, eligible, edgeCount);
  const hubEdges = addHubEdges(rng, eligible, hubs);
  const seen = new Set(baseEdges.map((e) => `${e.source}->${e.target}`));
  const edges = baseEdges;
  for (const e of hubEdges) {
    const key = `${e.source}->${e.target}`;
    if (e.source === e.target || seen.has(key)) continue;
    seen.add(key);
    edges.push(e);
  }

  const nodes: LineageNode[] = objs.map((o) => ({
    id: o.id,
    schema: o.schema,
    name: o.name,
    fullName: o.fullName,
    type: o.type,
  }));

  const externalNodes: LineageNode[] = [];
  const externalEdges: LineageEdge[] = [];
  for (const o of objs) {
    if (!o.isExternalCarrier || !o.externalUrl) continue;
    const extId = `[__ext__].[${hashString(o.externalUrl).toString(16).padStart(8, '0').slice(0, 8)}]`;
    externalNodes.push({
      id: extId,
      schema: '',
      name: o.externalUrl.split('/').pop() ?? extId,
      fullName: extId,
      type: 'external',
      externalType: 'file',
      externalUrl: o.externalUrl,
    });
    externalEdges.push({ source: extId, target: o.id, type: 'body' });
  }

  const allNodes = [...nodes, ...externalNodes];
  const allEdges = [...edges, ...externalEdges];

  const schemaCounts = new Map<
    string,
    { count: number; types: Record<ObjectType, number> }
  >();
  for (const n of nodes) {
    let entry = schemaCounts.get(n.schema);
    if (!entry) {
      entry = { count: 0, types: emptyTypeCounts() };
      schemaCounts.set(n.schema, entry);
    }
    entry.count++;
    entry.types[n.type]++;
  }
  const schemas: SchemaInfo[] = [...schemaCounts.entries()]
    .map(([name, entry]) => ({
      name,
      nodeCount: entry.count,
      types: entry.types,
    }))
    .sort((a, b) => b.nodeCount - a.nodeCount);

  const catalog: Record<string, CatalogEntry> = {};
  for (const n of allNodes) {
    catalog[n.id] = {
      schema: n.schema,
      name: n.name,
      type: n.type,
      ...(n.externalType && { externalType: n.externalType }),
    };
  }

  const neighborIndex: NeighborIndex = {};
  for (const n of allNodes) neighborIndex[n.id] = { in: [], out: [] };
  for (const e of allEdges) {
    neighborIndex[e.source].out.push(e.target);
    neighborIndex[e.target].in.push(e.source);
  }

  const model: DatabaseModel = {
    nodes: allNodes,
    edges: allEdges,
    schemas,
    catalog,
    neighborIndex,
    source: 'dacpac',
  };
  return { model, hubIds: hubs.map((h) => h.id) };
}
