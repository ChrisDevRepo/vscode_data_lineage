/**
 * Synthetic DACPAC writer for tests that need a real `model.xml` at an arbitrary object count — the
 * tracked fixtures top out around 150 objects, far below `dataLineageViz.maxNodes` (2000).
 *
 * @remarks
 * The graph shape itself comes from {@link generateDwhModel} (`dwhGraphGenerator.ts`) — the one
 * seeded DWH generator every large-graph test consumer shares. This module's only job is writing
 * that model out as a real `.dacpac` zip so the scale-boundary tests exercise the actual DACPAC
 * extraction path (`extractDacpac`), plus the ground truth the caller asserts against.
 *
 * Every non-external node's dependencies are declared through the structured `BodyDependencies`
 * relationship, placed on the *dependent* node and referencing its upstream node — the same shape
 * `dacpacExtractor.ts` reads directly. No node other than an external-ref carrier is given a
 * `BodyScript`, so `dacpacExtractor.ts` always takes the unconditional read-direction path
 * (`processNonSpEdges`) for every declared dependency: one XML reference always yields exactly one
 * edge, source and target exactly as generated. An external-ref carrier procedure instead gets an
 * `OPENROWSET` body and no `BodyDependencies`, so `modelBuilder.ts`'s independent external-reference
 * scan discovers it and creates the matching virtual node.
 */

import JSZip from 'jszip';
import type { DatabaseModel, ObjectType } from '../../../src/engine/types';
import { generateDwhModel, type DwhProfile } from './dwhGraphGenerator';

/** Parameters for {@link buildSyntheticDacpac}. */
export interface SyntheticDacpacParams {
  /** Total number of real (tracked) DACPAC objects to generate, spread across `schemaCount` schemas. */
  objectCount: number;
  /** Exact number of schemas to distribute the objects across. */
  schemaCount: number;
  /**
   * Number of `objectCount` objects (taken from the end of the sequence) that are procedures
   * referencing a distinct external file via `OPENROWSET`, each producing one virtual external
   * node in the built model. Defaults to `0`.
   */
  externalRefCount?: number;
  /** Seed forwarded to {@link generateDwhModel}; defaults to a fixed constant for reproducibility. */
  seed?: number;
  /** Realism tuning forwarded to {@link generateDwhModel}, beyond `schemaCount`/`externalRefCount`. */
  profile?: Omit<DwhProfile, 'schemaCount' | 'externalRefCount'>;
}

/** Ground truth a test asserts an extraction result against. */
export interface SyntheticDacpacResult {
  /** The zipped `.dacpac` archive bytes. */
  buffer: Uint8Array;
  /** Total real (tracked) object count generated — tables, views, and procedures. */
  objectCount: number;
  /** Number of distinct external references generated (each a unique `OPENROWSET` URL). */
  externalRefCount: number;
  /** `objectCount + externalRefCount` — the expected working-graph node count when nothing is filtered. */
  totalNodeCount: number;
  /** Schema names present in the generated model. */
  schemaNames: string[];
  /** Real object count per schema name. */
  perSchemaObjectCount: Record<string, number>;
  /** Expected resolved edge count from declared dependencies (excludes external-reference edges). */
  edgeCount: number;
}

const DEFAULT_SEED = 20260923;

const DACPAC_TYPE: Record<Exclude<ObjectType, 'external'>, string> = {
  table: 'SqlTable',
  view: 'SqlView',
  procedure: 'SqlProcedure',
  function: 'SqlScalarFunction',
};

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Serializes a {@link DatabaseModel} produced by {@link generateDwhModel} into a `model.xml` body.
 *
 * @param model - The generated model to serialize.
 * @returns The `model.xml` document text and the real (non-external) declared-dependency edge count.
 */
export function serializeDwhModelToXml(model: DatabaseModel): { xml: string; edgeCount: number } {
  const byId = new Map(model.nodes.map(n => [n.id, n]));

  const externalUrlByCarrier = new Map<string, string>();
  for (const e of model.edges) {
    const source = byId.get(e.source);
    if (source?.type === 'external' && source.externalUrl) externalUrlByCarrier.set(e.target, source.externalUrl);
  }

  const incomingByTarget = new Map<string, string[]>();
  let edgeCount = 0;
  for (const e of model.edges) {
    const source = byId.get(e.source);
    const target = byId.get(e.target);
    if (!source || !target || source.type === 'external' || target.type === 'external') continue;
    const arr = incomingByTarget.get(e.target) ?? [];
    arr.push(source.fullName);
    incomingByTarget.set(e.target, arr);
    edgeCount++;
  }

  const elements: string[] = [];
  for (const node of model.nodes) {
    if (node.type === 'external') continue;
    const dacpacType = DACPAC_TYPE[node.type];
    const url = externalUrlByCarrier.get(node.id);
    if (url) {
      const body = `SELECT * FROM OPENROWSET(BULK '${xmlEscape(url)}', FORMAT='CSV') AS r`;
      elements.push(`<Element Type="${dacpacType}" Name="${xmlEscape(node.fullName)}"><Property Name="BodyScript" Value="${xmlEscape(body)}" /></Element>`);
      continue;
    }
    const deps = incomingByTarget.get(node.id) ?? [];
    const relXml = deps.length === 0
      ? ''
      : `<Relationship Name="BodyDependencies">${deps.map(name => `<Entry><References Name="${xmlEscape(name)}" /></Entry>`).join('')}</Relationship>`;
    elements.push(`<Element Type="${dacpacType}" Name="${xmlEscape(node.fullName)}">${relXml}</Element>`);
  }

  const xml = `<?xml version="1.0" encoding="utf-8"?>\n`
    + `<DataSchemaModel DspName="Microsoft.Data.Tools.Schema.Sql.Sql160DatabaseSchemaProvider">\n`
    + `  <Model>\n${elements.join('\n')}\n  </Model>\n`
    + `</DataSchemaModel>`;

  return { xml, edgeCount };
}

/**
 * Builds a real `model.xml` at the requested size — via the shared {@link generateDwhModel} —
 * zipped into a `.dacpac` buffer, so the scale-boundary tests around `dataLineageViz.maxNodes`
 * exercise the actual DACPAC extraction path rather than a hand-built `DatabaseModel`.
 */
export async function buildSyntheticDacpac(params: SyntheticDacpacParams): Promise<SyntheticDacpacResult> {
  const { objectCount, schemaCount, externalRefCount = 0, seed = DEFAULT_SEED, profile } = params;
  if (schemaCount < 1) throw new Error('schemaCount must be at least 1');
  if (externalRefCount > objectCount) throw new Error('externalRefCount cannot exceed objectCount');

  const { model } = generateDwhModel({
    objectCount,
    seed,
    profile: { ...profile, schemaCount, externalRefCount },
  });

  const { xml, edgeCount } = serializeDwhModelToXml(model);

  const zip = new JSZip();
  zip.file('model.xml', xml);
  const buffer = await zip.generateAsync({ type: 'uint8array' });

  const perSchemaObjectCount: Record<string, number> = {};
  for (const s of model.schemas) perSchemaObjectCount[s.name] = s.nodeCount;
  const schemaNames = model.schemas.map(s => s.name);
  const realExternalRefCount = model.nodes.filter(n => n.type === 'external').length;
  const realObjectCount = model.nodes.length - realExternalRefCount;

  return {
    buffer,
    objectCount: realObjectCount,
    externalRefCount: realExternalRefCount,
    totalNodeCount: model.nodes.length,
    schemaNames,
    perSchemaObjectCount,
    edgeCount,
  };
}
