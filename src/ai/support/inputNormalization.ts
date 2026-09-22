/**
 * Input normalization helpers for AI-controlled fields.
 *
 * @remarks
 * Keeps boundary normalization deterministic and reusable across tool handlers,
 * state-machine init, and prompt rendering.
 */
import { z } from 'zod';
import { resolveModelNodeId } from '../../engine/shared/nodeIdResolution';

/**
 * Re-exported so AI callers keep importing node-id resolution from here.
 * The implementation moved to `src/engine/shared/` because the webview needs it too and must not
 * reach into `src/ai/**`.
 */
export { resolveModelNodeId };

/** Raw object-like `submit_findings` payload before strict BB/CT schema validation. */
export type SubmitFindingsInputObject = Record<string, unknown> & {
  focus_node_id?: unknown;
  prune_neighbors?: unknown;
  route_requests?: unknown;
  column_flow?: unknown;
};

/** Raw object-like `start_exploration` payload before strict semantic validation. */
export type StartExplorationInputObject = Record<string, unknown> & {
  analysisMode?: unknown;
  targetColumns?: unknown;
};

/** One encoding-level normalization applied before start-exploration validation. */
export interface StartExplorationNormalization {
  /** Field changed on the cloned provider payload. */
  readonly field: 'targetColumns';
  /** Stable reason suitable for boundary diagnostics. */
  readonly reason: 'empty_bb_array_to_absence' | 'string_encoded_array_to_array';
}

/**
 * Attempts to decode a JSON-string-encoded array (e.g. `"[\"ColA\"]"`) back into the array.
 *
 * @returns The decoded array, or `undefined` when the value is not a string or does not
 * parse to a JSON array (the caller keeps the original value so Zod's own error surfaces).
 */
function parseStringEncodedArray(value: unknown): unknown[] | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = z.array(z.unknown()).safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Array schema that deterministically unwraps a JSON-string-encoded array before validation.
 *
 * @remarks
 * Some local OpenAI-compatible servers (Qwen/oMLX lane) emit array-typed tool arguments as
 * JSON strings (`{"targetColumns": "[\"TotalRevenue\"]"}`). This is encoding-only
 * normalization per the middleware contract — the mirror of `z.coerce.number()` for depth
 * fields: a string is unwrapped ONLY when it parses to a JSON array; any other value
 * (including a non-JSON string or a string encoding a non-array) passes through untouched so
 * the inner `z.array` rejection surfaces normally. Transparent to `z.toJSONSchema`
 * (`io: 'input'`), so the model-facing tool schema is unchanged (pinned by
 * `tests/unit/sm/strict-tool-arrays.test.ts`).
 *
 * @param element - Element schema for the inner `z.array`.
 * @param bounds - Optional `min`/`max` length bounds applied to the inner array.
 * @returns The preprocess-wrapped array schema; output type is identical to `z.array(element)`.
 */
export function coercedStringArray<T extends z.ZodType>(
  element: T,
  bounds: { min?: number; max?: number } = {},
) {
  let array = z.array(element);
  if (bounds.min !== undefined) array = array.min(bounds.min);
  if (bounds.max !== undefined) array = array.max(bounds.max);
  return z.preprocess((value) => parseStringEncodedArray(value) ?? value, array);
}

/**
 * Preprocess that decodes a string-encoded JSON `null` literal (`"null"`) into real `null` before
 * validation.
 *
 * @remarks
 * Nullable sibling of {@link coercedStringArray} for the local OpenAI-compatible (Qwen/oMLX and
 * LM Studio) lanes, which emit JSON `null` arguments as the string literal `"null"`
 * (`{"targetColumns": "null"}`). This is encoding-only normalization per the middleware contract:
 * only the exact string `"null"` is unwrapped; every other value (including a genuine `null`, an
 * array, or any other string) passes through untouched so the wrapped schema's own rejection
 * surfaces normally. Transparent to `z.toJSONSchema` (`io: 'input'`), so the model-facing tool
 * schema is unchanged.
 *
 * @param schema - Schema to wrap; typically a nullable array or scalar schema.
 * @returns The preprocess-wrapped schema; output type is identical to the wrapped schema.
 */
export function coercedStringNull<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === 'null' ? null : value), schema);
}

/**
 * Preprocess that treats a genuine JSON `null` (or its string-encoded literal `"null"`) as
 * property absence before an optional schema parses.
 *
 * @remarks
 * Sibling of {@link coercedStringNull} for an `.optional()` (non-nullable) field the engine
 * already treats as absence-equivalent: a provider sending `column_flow.0.writes_to: null` is
 * rejected as `expected object, received null` and can run the turn into the semantic-failure
 * breaker (`writes_to` is a `.strict()` object schema with `.optional()`, never `.nullable()`).
 * The two engine readers of this field
 * (`src/ai/sm/columnTracer.ts`, `src/ai/sm/smBase.ts`) already read `entry.writes_to?.node` /
 * `?.col` with optional chaining, so `null` and `undefined` already mean the same thing
 * ("no redirect") to every consumer — only the schema was stricter than its readers. Encoding-only
 * normalization per the middleware contract: only a genuine `null` or the exact string `"null"` is
 * mapped to `undefined`; every other value (including a genuine object) passes through untouched
 * so the wrapped schema's own rejection surfaces normally. Transparent to `z.toJSONSchema`
 * (`io: 'input'`), so the model-facing tool schema is unchanged.
 *
 * @param schema - Optional schema to wrap; typically a `.strict()` object schema carrying its own
 * `.optional()`.
 * @returns The preprocess-wrapped schema; output type is identical to `schema`.
 */
export function nullAsAbsent<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === null || value === 'null' ? undefined : value), schema);
}

/**
 * Preprocess that drops keys the wrapped object schema does not declare, before it parses.
 *
 * @remarks
 * Sibling of {@link nullAsAbsent} for the `column_flow` entry shape (`src/ai/tools/toolSchemas.ts`),
 * where a surplus key is absence-equivalent to every reader: the engine reads named fields off the
 * parsed entry (`src/ai/sm/columnTracer.ts`, `src/ai/sm/smBase.ts`) and no consumer can see a key
 * the schema never declared. Only the entry envelope is normalized — the values of the declared
 * fields pass through untouched so their own rejections surface normally. Removes the
 * provider-prevalidation rejection an unknown key raised (`vscodeModelPort` parses the registered
 * union before the handler runs), so the payload reaches the handler and the schema strips there
 * instead; the advertised contract is unchanged — `.strict()` is retained, so
 * `additionalProperties: false` still tells the model not to send surplus keys, and the
 * model-facing JSON Schema is byte-identical (`z.toJSONSchema`, `io: 'input'`, is transparent to
 * `z.preprocess`).
 *
 * @param schema - The object schema whose declared keys define what survives.
 * @returns The preprocess-wrapped schema; output type is identical to `schema`.
 */
export function declaredKeysOnly<T extends z.ZodObject>(schema: T) {
  const declared = new Set(Object.keys(schema.shape));
  return z.preprocess((value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    const entries = Object.entries(value as Record<string, unknown>).filter(([key]) => declared.has(key));
    return entries.length === Object.keys(value as Record<string, unknown>).length
      ? value
      : Object.fromEntries(entries);
  }, schema);
}

/**
 * Key paths a raw tool payload carries that its parsed form does not — what {@link declaredKeysOnly}
 * or a non-strict object schema stripped.
 *
 * @param raw - The payload as the model sent it.
 * @param parsed - The same payload after a successful schema parse.
 * @returns Dotted paths (`column_flow.0.bogus`), empty when nothing was dropped.
 *
 * @remarks
 * The strip itself runs inside a schema, where no logger is reachable; the caller that holds both
 * forms logs this list so a dropped parameter is never silent. Walks objects and arrays in step and
 * stops where the parse changed a value's kind (a decoded JSON string, a coerced scalar). A raw
 * `null` is not reported: {@link nullAsAbsent} maps it to absence by contract.
 */
export function droppedKeyPaths(raw: unknown, parsed: unknown, path = ''): string[] {
  const at = (key: string | number) => (path ? `${path}.${key}` : String(key));
  if (Array.isArray(raw)) {
    return Array.isArray(parsed) ? raw.flatMap((item, i) => droppedKeyPaths(item, parsed[i], at(i))) : [];
  }
  if (!raw || typeof raw !== 'object' || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  return Object.entries(raw as Record<string, unknown>).flatMap(([key, value]) => {
    if (!(key in parsed)) return value === null ? [] : [at(key)];
    return droppedKeyPaths(value, (parsed as Record<string, unknown>)[key], at(key));
  });
}

/**
 * Attempts to decode a JSON-string-encoded object (e.g. `"{\"upstream\": 1}"`) back into the
 * object.
 *
 * @returns The decoded plain object, or `undefined` when the value is not a string or does not
 * parse to a JSON object (the caller keeps the original value so Zod's own error surfaces).
 */
function parseStringEncodedObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Object schema that deterministically unwraps a JSON-string-encoded object before validation.
 *
 * @remarks
 * Object sibling of {@link coercedStringArray} for the local OpenAI-compatible (Qwen/oMLX)
 * lane, which can emit object-typed tool arguments as JSON strings — observed 2026-08-30 on
 * that lane: `depth: "{\"upstream\": 1, \"downstream\": 1}"` was rejected three
 * times as `invalid_tool_input`, stopping the turn on cumulative semantic failures, although
 * every other argument was valid and the provider repeats the identical encoding on every
 * repair attempt (the model cannot see or fix a transport-side re-encoding). Encoding-only
 * normalization per the middleware contract: a string is unwrapped ONLY when it parses to a
 * JSON object; any other value (including a JSON scalar such as `"2"`, the literal `"all"`, a
 * non-JSON string, or a genuine object/array) passes through untouched so the wrapped schema's
 * own rejection surfaces normally. Transparent to `z.toJSONSchema` (`io: 'input'`), so the
 * model-facing tool schema is unchanged.
 *
 * @param schema - Schema to wrap; typically a strict object schema or a union carrying one.
 * @returns The preprocess-wrapped schema; output type is identical to the wrapped schema.
 */
export function coercedStringObject<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => parseStringEncodedObject(value) ?? value, schema);
}

/**
 * Decodes a JSON-string-encoded boolean literal (`"true"`/`"True"`/`"false"`/`"False"`) back
 * into its boolean value.
 *
 * @returns The decoded boolean, or `undefined` for any other value (the caller keeps the
 * original value so `z.boolean()`'s own rejection surfaces for anything not in this allowlist).
 */
function parseStringEncodedBoolean(value: unknown): boolean | undefined {
  if (value === 'true' || value === 'True') return true;
  if (value === 'false' || value === 'False') return false;
  return undefined;
}

/**
 * Boolean schema that deterministically unwraps a JSON-string-encoded boolean before validation.
 *
 * @remarks
 * Boolean sibling of {@link coercedStringArray} for the local OpenAI-compatible (Qwen/oMLX)
 * lane, which emits boolean tool arguments as JSON strings (`{"include_ddl": "true"}`). This is
 * encoding-only normalization per the middleware contract: a string is unwrapped ONLY when it is
 * exactly `"true"`/`"True"`/`"false"`/`"False"`; any other value (including a genuine boolean or
 * an unrelated string) passes through untouched so `z.boolean()`'s own rejection surfaces
 * normally. Deliberately NOT `z.coerce.boolean()` — that coerces every non-empty string
 * (including the literal `"false"`) to `true`, silently inverting the field's meaning. Transparent
 * to `z.toJSONSchema` (`io: 'input'`), so the model-facing tool schema is unchanged.
 *
 * @returns The preprocess-wrapped boolean schema; output type is identical to `z.boolean()`.
 */
export function coercedBoolean() {
  return z.preprocess((value) => parseStringEncodedBoolean(value) ?? value, z.boolean());
}

/**
 * Relocates a `present_result` section's nested `notes` array onto the payload's top-level
 * `notes[]` field before Zod parses it.
 *
 * @remarks
 * Measured 2026-09-16 on independent `m17-bundle-azure-foundry` (run-T7) and
 * `m17-head-azure-foundry` (run-T8) captures: the model repeatedly nests a below-node caption list
 * inside the section it groups them under (`sections.N.notes`) instead of `present_result`'s one
 * legal home for that shape, the payload's top-level `notes[]`
 * ({@link PresentResultModelSchema}) — `sections.1: Unrecognized key: "notes"` on 2-of-3 sections in
 * run-T7, then 4-of-4 in run-T8's next attempt, each nested entry already exactly the top-level
 * shape (`{node_id, text}`). Both turns then spent their whole synthesis semantic-failure budget on
 * repeats of the identical placement mistake and ended with no answer at all
 * (`MAX_TOOL_SEMANTIC_FAILURES`, `graph.ts`). Hoisting loses nothing and invents nothing — the same
 * accept-a-materially-equivalent-placement contract {@link coercedStringObject} and
 * {@link coercedStringArray} already apply to an alternate provider encoding, extended here to an
 * alternate placement of identically-shaped structured data. A relocated entry is never validated
 * here — deferred to the top-level `notes[]` schema, so a malformed one still rejects there with its
 * own issue path. `droppedKeyPaths` (the caller's raw-vs-parsed diff, `vscodeModelPort.ts`,
 * `openAiCompatiblePort.ts`) reports the vacated `sections.N.notes` path, so a relocation is never
 * silent. Transparent to `z.toJSONSchema` (`io: 'input'`), so the model-facing tool schema is
 * unchanged — same contract as every other wrapper in this module.
 *
 * @param value - Raw model payload before Zod validation; anything but a plain object carrying a
 * `sections` array with at least one `notes`-bearing entry passes through untouched.
 * @returns The payload with every section's `notes` array moved onto the top-level `notes[]` array
 * (appended after any notes already there) and stripped from its section, or `value` unchanged.
 */
export function hoistSectionNotes(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const sections = record.sections;
  if (!Array.isArray(sections) || !sections.some(isRecordWithNotes)) return value;

  const hoistedNotes: unknown[] = Array.isArray(record.notes) ? [...record.notes] : [];
  const rewrittenSections = sections.map((section) => {
    if (!isRecordWithNotes(section)) return section;
    const { notes, ...rest } = section;
    hoistedNotes.push(...(Array.isArray(notes) ? notes : [notes]));
    return rest;
  });
  return { ...record, sections: rewrittenSections, notes: hoistedNotes };
}

/** Plain object carrying its own `notes` key, regardless of that key's shape. */
function isRecordWithNotes(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && 'notes' in value;
}

/** Result of cloning and normalizing a raw start-exploration payload. */
export interface StartExplorationNormalizationResult {
  /** Cloned payload passed to strict semantic validation. */
  readonly input: StartExplorationInputObject;
  /** Encoding-only changes made to the clone. */
  readonly normalizations: StartExplorationNormalization[];
}

/**
 * Converts provider-emitted encodings of `targetColumns` to their canonical form: a
 * JSON-string-encoded array is decoded, and an empty BB target list becomes property absence.
 *
 * The raw object is never mutated. Non-empty arrays and non-BB payloads are preserved so
 * strict Zod validation can reject semantic conflicts and malformed values.
 *
 * @param rawInput - Raw model tool payload.
 * @param effectiveModeHint - Valid explicit mode or the mode inherited by a refine call.
 * @returns A cloned payload plus observable encoding-normalization events.
 */
export function normalizeStartExplorationInput(
  rawInput: StartExplorationInputObject,
  effectiveModeHint?: 'bb' | 'ct',
): StartExplorationNormalizationResult {
  const input = { ...rawInput };
  const normalizations: StartExplorationNormalization[] = [];
  // Decode before the empty-BB check so a string-encoded "[]" also normalizes to absence.
  const decoded = parseStringEncodedArray(input.targetColumns);
  if (decoded !== undefined) {
    input.targetColumns = decoded;
    normalizations.push({ field: 'targetColumns', reason: 'string_encoded_array_to_array' });
  }
  if (effectiveModeHint === 'bb' && Array.isArray(input.targetColumns) && input.targetColumns.length === 0) {
    delete input.targetColumns;
    normalizations.push({ field: 'targetColumns', reason: 'empty_bb_array_to_absence' });
  }
  return { input, normalizations };
}

type RouteRequestInputObject = Record<string, unknown> & {
  nodeId?: unknown;
};

/** One field-level ID canonicalization applied to a cloned `submit_findings` payload. */
export interface SubmitFindingsIdNormalization {
  /** Dot-path of the normalized field in the cloned input. */
  readonly field: string;
  /** Original model-supplied ID spelling. */
  readonly from: string;
  /** Canonical model ID used for validation and dispatch. */
  readonly to: string;
}

/** Result of cloned `submit_findings` ID normalization. */
export interface SubmitFindingsNormalizationResult {
  /** Cloned payload passed to strict mode-specific Zod validation. */
  readonly input: SubmitFindingsInputObject;
  /** Canonicalization events emitted for debug logging. */
  readonly normalizations: SubmitFindingsIdNormalization[];
}

/**
 * Resolves multiple node ids while preserving order and removing duplicates.
 *
 * @param raws - An array of raw node id strings.
 * @param nodeMap - The map of canonical nodes to check against.
 * @returns An object containing resolved and unresolved node id arrays.
 */
export function resolveModelNodeIds(
  raws: string[],
  nodeMap: Map<string, unknown>,
): { resolved: string[]; unresolved: string[] } {
  const resolved: string[] = [];
  const unresolved: string[] = [];
  const seenResolved = new Set<string>();
  for (const raw of raws) {
    const id = resolveModelNodeId(raw, nodeMap);
    if (!id) {
      unresolved.push(raw);
      continue;
    }
    if (seenResolved.has(id)) continue;
    seenResolved.add(id);
    resolved.push(id);
  }
  return { resolved, unresolved };
}

/**
 * Normalizes submit_findings node-id encodings into a cloned input object.
 *
 * @remarks
 * This is intentionally narrow: it canonicalizes bracket/case/name encodings only
 * and never removes unknown fields or changes the raw object supplied by the model.
 * The caller must still run the cloned output through the strict BB/CT Zod schema.
 *
 * @param rawInput - Raw model input object.
 * @param nodeMap - Canonical model node map used by {@link resolveModelNodeId}.
 * @returns The cloned input and a list of field-level normalization events.
 */
export function normalizeSubmitFindingsInputIds(
  rawInput: SubmitFindingsInputObject,
  nodeMap: Map<string, unknown>,
): SubmitFindingsNormalizationResult {
  const input: SubmitFindingsInputObject = { ...rawInput };
  const normalizations: SubmitFindingsIdNormalization[] = [];
  const note = (field: string, from: string, to: string): void => {
    if (from !== to) normalizations.push({ field, from, to });
  };

  if (typeof rawInput.focus_node_id === 'string') {
    const resolved = resolveModelNodeId(rawInput.focus_node_id, nodeMap);
    if (resolved) {
      input.focus_node_id = resolved;
      note('focus_node_id', rawInput.focus_node_id, resolved);
    }
  }

  if (Array.isArray(rawInput.prune_neighbors)) {
    input.prune_neighbors = rawInput.prune_neighbors.map((id, index) => {
      if (typeof id !== 'string') return id;
      const resolved = resolveModelNodeId(id, nodeMap) ?? id;
      note(`prune_neighbors.${index}`, id, resolved);
      return resolved;
    });
  }

  if (Array.isArray(rawInput.route_requests)) {
    input.route_requests = rawInput.route_requests.map((req, index) => {
      if (req && typeof req === 'object' && !Array.isArray(req)) {
        const route = req as RouteRequestInputObject;
        if (typeof route.nodeId === 'string') {
          const resolved = resolveModelNodeId(route.nodeId, nodeMap) ?? route.nodeId;
          note(`route_requests.${index}.nodeId`, route.nodeId, resolved);
          return { ...route, nodeId: resolved };
        }
      }
      return req;
    });
  }

  return { input, normalizations };
}

/**
 * Normalizes a free-form `lineage_search_objects.query` string.
 *
 * @remarks
 * Accepts common id-like forms the AI may emit (e.g. `[dbo].[FactSales]`,
 * `dbo.FactSales`, `[db].[dbo].[FactSales]`) and extracts:
 * - `query`: the object token to search by (e.g. `FactSales`)
 * - `schemaHint`: optional schema token (`dbo`) usable as a schema filter
 *
 * If parsing fails, returns the trimmed input unchanged and no schema hint.
 *
 * @param raw - The free-form query string.
 * @returns An object with the extracted query and optional schema hint.
 */
export function normalizeSearchQueryInput(raw: string): { query: string; schemaHint?: string } {
  const input = (raw ?? '').trim();
  if (!input) return { query: '' };

  const debracket = (s: string): string => s.replace(/^\[|\]$/g, '');
  const parts = input.split('.').map(p => debracket(p.trim())).filter(Boolean);

  // [name] / name
  if (parts.length === 1) return { query: parts[0] };
  // [schema].[name] / schema.name
  if (parts.length === 2) return { query: parts[1], schemaHint: parts[0] };
  // [db].[schema].[name] / db.schema.name
  if (parts.length === 3) return { query: parts[2], schemaHint: parts[1] };

  return { query: input };
}
