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
 * Implementation lives in `src/engine/shared/` because the webview needs it too and must not
 * reach into `src/ai/**`.
 */
export { resolveModelNodeId };

/** Raw object-like `submit_findings` payload before strict BB/CT schema validation. */
export type SubmitFindingsInputObject = Record<string, unknown> & {
  focus_node_id?: unknown;
  prune_neighbors?: unknown;
  questions?: unknown;
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
 * (`io: 'input'`), so the model-facing tool schema is unchanged.
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
 *
 * An array whose parsed length exceeds its raw length is never a plain kind change — a repair
 * spliced elements in immediately after the raw element that carried them:
 * {@link repairArrayBoundaryArtifacts} recovered sibling elements from an artifact-boundary key, or
 * {@link hoistSectionTopLevelFields} flattened a `sections` array nested inside a section.
 * Index-zipping raw and parsed in that case would compare each element against the wrong sibling
 * from the splice point on and report every one of them as a spurious drop. Instead the walk keeps
 * an independent parsed-side cursor that advances past exactly the spliced elements a re-derivation
 * of that same repair produces (a pure, deterministic replay of the repair's own extraction, not a
 * second source of truth for what was recovered), and reports the splice itself as a distinct entry
 * — `NORMALIZE-WITH-LOG`'s "add" half. An artifact rejoin is reported alongside the vacated
 * artifact key the object-level walk already reports as a drop; a flattened nested `sections` array
 * is reported in place of that vacated key, and each nested entry is walked against its spliced
 * counterpart so a key removed from it is named at its own path. A whitespace-only key that
 * {@link rejoinSectionTextBoundaryArtifacts} folded back into `text` is named as a rejoin, not a drop.
 */
export function droppedKeyPaths(raw: unknown, parsed: unknown, path = ''): string[] {
  const at = (key: string | number) => (path ? `${path}.${key}` : String(key));
  if (Array.isArray(raw)) {
    if (!Array.isArray(parsed)) return [];
    if (parsed.length === raw.length) {
      return raw.flatMap((item, i) => droppedKeyPaths(item, parsed[i], at(i)));
    }
    const paths: string[] = [];
    let parsedIndex = 0;
    for (let rawIndex = 0; rawIndex < raw.length; rawIndex++) {
      const rawItem = raw[rawIndex];
      const parsedItem = parsed[parsedIndex];
      const itemPaths = droppedKeyPaths(rawItem, parsedItem, at(rawIndex));
      parsedIndex++;
      if (isPlainObject(rawItem) && Array.isArray(rawItem.sections) && rawItem.sections.length > 0
        && isPlainObject(parsedItem) && !('sections' in parsedItem)) {
        const nested = rawItem.sections;
        const vacated = `${at(rawIndex)}.sections`;
        paths.push(...itemPaths.map(p => (p === vacated ? `${vacated} (flattened ${nested.length} nested section(s))` : p)));
        nested.forEach((entry, j) => paths.push(...droppedKeyPaths(entry, parsed[parsedIndex + j], `${vacated}.${j}`)));
        parsedIndex += nested.length;
        continue;
      }
      paths.push(...itemPaths);
      if (!isPlainObject(rawItem)) continue;
      const artifactKey = Object.keys(rawItem).find((key) => ARRAY_BOUNDARY_ARTIFACT_KEY.test(key));
      if (artifactKey === undefined) continue;
      const rawValue = rawItem[artifactKey];
      const recovered = typeof rawValue === 'string'
        ? extractBalancedJsonObjects(`${artifactKey}"${rawValue}`)
        : null;
      if (recovered && recovered.length > 0) {
        paths.push(`${at(rawIndex)}.${artifactKey} (rejoined ${recovered.length} sibling element(s))`);
        parsedIndex += recovered.length;
      }
    }
    return paths;
  }
  if (!raw || typeof raw !== 'object' || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const record = raw as Record<string, unknown>;
  return Object.entries(record).flatMap(([key, value]) => {
    if (!(key in parsed) && isTextBoundaryArtifact(record, key)) {
      return [`${path ? `${path}.` : ''}${JSON.stringify(key)} (rejoined into text)`];
    }
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
 * lane, which can emit object-typed tool arguments as JSON strings (e.g.
 * `depth: "{\"upstream\": 1, \"downstream\": 1}"`); an unrepaired encoding stops the turn on
 * cumulative semantic failures even though every other argument was valid, since the model
 * cannot see or fix a transport-side re-encoding it repeats on every repair attempt.
 * Encoding-only normalization per the middleware contract: a string is unwrapped ONLY when it parses to a
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
 * The model repeatedly nests a below-node caption list inside the section it groups them under
 * (`sections.N.notes`) instead of `present_result`'s one legal home for that shape, the payload's
 * top-level `notes[]` ({@link PresentResultModelSchema}), each nested entry already exactly the
 * top-level shape (`{node_id, text}`). Left unrepaired, a turn can spend its whole synthesis
 * semantic-failure budget on repeats of the identical placement mistake and end with no answer at
 * all (`MAX_TOOL_SEMANTIC_FAILURES`, `graph.ts`). Hoisting loses nothing and invents nothing — the same
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

/** The one top-level text field whose differing section copy is folded into that section's `text`. */
const FOLDED_TEXT_FIELD = 'summary';

/**
 * Top-level display labels where the first carrying section's value is kept and a differing copy in
 * a later section is removed; `droppedKeyPaths` reports the removed path.
 */
const FIRST_WINS_LABEL_FIELDS: ReadonlySet<string> = new Set(['badge_label']);

/** Deep-equality key for deduping a merged array entry so a repeated element is counted once. */
function dedupeKey(entry: unknown): string {
  return JSON.stringify(entry);
}

/**
 * Concatenates a section-nested array field onto the top-level array of the same field, dropping
 * entries already present (deep equality) so a repeated element is never carried twice.
 */
function mergeArrayField(top: unknown[], nested: unknown[]): unknown[] {
  const seen = new Set(top.map(dedupeKey));
  const merged = [...top];
  for (const entry of nested) {
    const key = dedupeKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged;
}

/** Returns `record` without `key`. */
function withoutKey(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _omitted, ...rest } = record;
  return rest;
}

/**
 * Appends the entries of a `sections` array nested inside a section right after that section, so a
 * finding whose remaining sections were authored inside its first section keeps every section.
 */
function flattenNestedSections(sections: unknown[]): { sections: unknown[]; changed: boolean } {
  let changed = false;
  const flat = sections.flatMap((section) => {
    if (!isPlainObject(section) || !Array.isArray(section.sections)) return [section];
    changed = true;
    return [withoutKey(section, 'sections'), ...section.sections];
  });
  return { sections: flat, changed };
}

/**
 * Moves `submit_findings` top-level fields authored inside `sections[]` entries to the top level;
 * merges rather than drops when the top level or another section already carries the field.
 *
 * @remarks
 * Sibling of {@link hoistSectionNotes} for the per-hop finding: a provider that nests top-level
 * fields inside `sections[N]` (otherwise rejected as `sections.0: Unrecognized key(s)`) sent them in
 * another place. A `sections` array nested in a section is flattened in place first. Then each
 * field is repaired by its shape, over every carrying section in order:
 * - An array field (`prune_neighbors`, `questions`, `column_flow`): every carried array is
 *   concatenated onto the top-level one ({@link mergeArrayField}, deduped) and removed from its
 *   section.
 * - `summary`: the first copy becomes the top-level summary when none exists; a copy identical to
 *   the top-level sentence (ignoring surrounding whitespace) is removed; a differing copy is folded
 *   onto its own section's `text` (appended, unless `text` already contains it).
 * - Any other string: relocated when absent at the top level, removed when identical to the value
 *   already there. A differing copy of a display label ({@link FIRST_WINS_LABEL_FIELDS}) is removed,
 *   the first value kept; any other differing value passes through so the strict schema rejects it.
 *
 * A carried value of the wrong shape passes through untouched for the same reason. `droppedKeyPaths`
 * reports the vacated section path for every field this relocates, folds or removes.
 *
 * @param value - Raw model payload before Zod validation.
 * @param fields - The finding schema's own top-level keys other than `sections`, supplied by the
 * caller so this module states no schema-owned constant of its own.
 * @returns The repaired payload, or `value` unchanged.
 */
export function hoistSectionTopLevelFields(value: unknown, fields: readonly string[]): unknown {
  if (!isPlainObject(value) || !Array.isArray(value.sections)) return value;
  const flattened = flattenNestedSections(value.sections as unknown[]);
  let sections = flattened.sections;
  const topPatch: Record<string, unknown> = {};
  let changed = flattened.changed;

  const replaceSection = (index: number, next: Record<string, unknown>): void => {
    sections = sections.map((section, i) => (i === index ? next : section));
    changed = true;
  };

  for (const field of fields) {
    const carrierIndexes = sections
      .map((section, index) => (isPlainObject(section) && field in section ? index : -1))
      .filter(index => index !== -1);
    if (carrierIndexes.length === 0) continue;

    for (const carrierIndex of carrierIndexes) {
      const carrier = sections[carrierIndex] as Record<string, unknown>;
      const carrierValue = carrier[field];
      const topValue = field in topPatch ? topPatch[field] : value[field];

      if (Array.isArray(carrierValue)) {
        if (topValue !== undefined && !Array.isArray(topValue)) continue;
        topPatch[field] = mergeArrayField(topValue ?? [], carrierValue);
        replaceSection(carrierIndex, withoutKey(carrier, field));
        continue;
      }
      if (typeof carrierValue !== 'string') continue;

      if (topValue === undefined) {
        topPatch[field] = carrierValue;
        replaceSection(carrierIndex, withoutKey(carrier, field));
        continue;
      }
      if (typeof topValue !== 'string') continue;
      const identical = topValue.trim() === carrierValue.trim();

      if (field === FOLDED_TEXT_FIELD) {
        if (typeof carrier.text !== 'string') continue;
        const text = identical || carrier.text.includes(carrierValue) ? carrier.text : `${carrier.text} ${carrierValue}`;
        replaceSection(carrierIndex, { ...withoutKey(carrier, field), text });
        continue;
      }
      if (identical || FIRST_WINS_LABEL_FIELDS.has(field)) {
        replaceSection(carrierIndex, withoutKey(carrier, field));
      }
    }
  }

  return changed ? { ...value, ...topPatch, sections } : value;
}

/**
 * Splits a `sections[]` entry that carries a key equal to a declared angle other than its own
 * `angle` value into a second `sections[]` entry naming that angle, so a second capture recipe's
 * whole body flattened under its own angle name becomes the section entry the strict schema
 * already expects instead of an unrecognized key.
 *
 * @remarks
 * Sibling of {@link hoistSectionNotes} for the two-angle capture shape (`CapturedSectionSchema`,
 * `src/ai/tools/toolSchemas.ts`): a provider that fires both capture templates in one turn can
 * collapse the second into a sibling key on the first, naming the missing entry's angle as a key
 * rather than opening a new array element (otherwise rejected as `sections.0: Unrecognized key:
 * "technical"`, a shape a plain retry reproduces). When no section already carries that angle, the
 * flattened body is appended as its own `{angle, text}` entry; when one already does, the flattened
 * body is folded onto that section's `text` instead (appended, unless already present) — either
 * way nothing is dropped. Under a single-angle classification lock the split-out entry then fails
 * the dispatch schema's angle narrowing, whose rejection directs the model to fold that content
 * into the kept section. A key whose value is not a string, or that does not match a declared
 * angle, passes through untouched so the strict schema still rejects it with its own issue path.
 * `droppedKeyPaths` reports the vacated key.
 *
 * @param value - Raw model payload before Zod validation.
 * @param angles - The full set of valid section angle names (`CapturedSectionSchema`'s own `angle`
 * enum values), supplied by the caller so this module states no schema-owned constant of its own.
 * @returns The payload with every flattened angle body split out or folded in, or `value` unchanged.
 */
export function splitFlattenedAngleSections(value: unknown, angles: readonly string[]): unknown {
  if (!isPlainObject(value) || !Array.isArray(value.sections)) return value;
  const original = value.sections as unknown[];
  let changed = false;
  const stripped: unknown[] = [];
  const pending: { angle: string; text: string }[] = [];

  for (const section of original) {
    if (!isPlainObject(section) || typeof section.angle !== 'string') {
      stripped.push(section);
      continue;
    }
    const flattenedAngle = angles.find(angle => angle !== section.angle && typeof section[angle] === 'string');
    if (flattenedAngle === undefined) {
      stripped.push(section);
      continue;
    }
    changed = true;
    const flattenedText = section[flattenedAngle] as string;
    const { [flattenedAngle]: _omittedAngle, ...rest } = section;
    stripped.push(rest);
    pending.push({ angle: flattenedAngle, text: flattenedText });
  }
  if (!changed) return value;

  const result = [...stripped];
  for (const { angle, text } of pending) {
    const existingIndex = result.findIndex(entry => isPlainObject(entry) && entry.angle === angle);
    if (existingIndex === -1) {
      result.push({ angle, text });
      continue;
    }
    const existing = result[existingIndex] as Record<string, unknown>;
    const existingText = typeof existing.text === 'string' ? existing.text : '';
    const mergedText = existingText.includes(text) ? existingText : `${existingText} ${text}`.trim();
    result[existingIndex] = { ...existing, text: mergedText };
  }

  return { ...value, sections: result };
}

/** Plain object carrying its own `notes` key, regardless of that key's shape. */
function isRecordWithNotes(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && 'notes' in value;
}

/** Plain (non-array, non-null) object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A key built entirely from JSON's own structural punctuation (`{ } [ ] , :`) and nothing else.
 *
 * @remarks
 * No field any `present_result`-family (or other tool) schema declares is spelled this way — every
 * real key is a word. A key matching this is never authored content; it is where a tokenizer landed
 * after a raw array-element boundary token (the `},{` that should close one element and open the
 * next, or a bare separator `,`) got swept into a quoted key instead of staying unquoted JSON
 * structure, with whatever followed swallowed into that key's string value. Whitespace around or
 * between the structural characters is tolerated (`}, {`, `},\n{`) — a provider that pretty-prints
 * tool-call arguments emits the identical defect with insignificant whitespace inside the swept
 * key, and this is the general defect class, not one compact-JSON provider's spacing; at least one
 * structural character is still required, so a whitespace-only key never matches: it marks a string
 * that closed early inside one element, not an element boundary ({@link WHITESPACE_ONLY_KEY}).
 */
const ARRAY_BOUNDARY_ARTIFACT_KEY = /^[{}[\],:\s]*[{}[\],:][{}[\],:\s]*$/;

/**
 * Finds the end index (inclusive) of the balanced `{...}` object literal starting at `text[start]`,
 * treating quoted-string content (respecting backslash escapes) as opaque so a brace appearing
 * inside a string value never perturbs the depth count.
 *
 * @returns The index of the matching closing `}`, or -1 when the text runs out unbalanced.
 */
function findBalancedObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Extracts every top-level `{...}` JSON object literal out of `text`, in encounter order,
 * tolerating only structural glue (whitespace, and stray `, [ ] }` characters) between and around
 * them.
 *
 * @returns The recovered objects (possibly empty), or `null` the instant anything besides a
 * balanced object literal or glue is encountered — the signal that the text is not a clean rejoin
 * of sibling elements and recovery must not guess at it.
 */
function extractBalancedJsonObjects(text: string): Record<string, unknown>[] | null {
  const objects: Record<string, unknown>[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/[\s,[\]}]/.test(ch)) { i++; continue; }
    if (ch !== '{') return null;
    const end = findBalancedObjectEnd(text, i);
    if (end === -1) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.slice(i, end + 1));
    } catch {
      return null;
    }
    if (!isPlainObject(parsed)) return null;
    objects.push(parsed);
    i = end + 1;
  }
  return objects;
}

/**
 * Repairs a broken array-element boundary in an already-JSON-parsed tool payload: an array element
 * (a plain object) that carries a key made solely of JSON structural punctuation is not a field the
 * model authored — it is the element-boundary token itself, misrouted into a quoted key/value pair
 * by a transport-side serialization defect, with everything that followed (up to and including
 * further sibling elements) swept into that key's string value.
 *
 * @remarks
 * A non-streaming `lineage_present_result` tool-call body can arrive with a section carrying an
 * extra key spelled only with structural characters, whose value is the raw (already
 * JSON-escaped-and-recoverable) text of the sibling elements that should have followed. Every
 * occurrence is one signature — the boundary token that should have stayed raw JSON structure was
 * quoted and swept a tail of real content into one key's value — but the payload can differ in what
 * is recoverable: one artifact's value decodes back into further complete elements (rejoined onto
 * the array, nothing lost); another's value is a bare fragment with nothing inside it to recover
 * (the key is dropped, the element's own real fields are untouched). `PresentResultSectionSchema` is
 * `.strict()` (this module's caller declares the array shape), so an unrepaired artifact key can
 * spend the run's synthesis semantic-failure strikes on `invalid_tool_input` and end the turn with a
 * 0-byte answer.
 *
 * This is the general defect class, not a fix keyed to one literal boundary token, one field name,
 * or one provider: {@link ARRAY_BOUNDARY_ARTIFACT_KEY} matches any key built solely from JSON's own
 * structural characters, on any array of plain objects found anywhere in the payload (a full deep
 * walk, not a `sections`-only check). Recovery rejoins the artifact key's own text with its value
 * (reconstructing what the boundary token plus swallowed tail would have read as raw JSON) and
 * extracts every complete, balanced object literal it contains via
 * {@link extractBalancedJsonObjects}; those elements are spliced back into the array immediately
 * after the element that carried the artifact, in order, so nothing recoverable is dropped. When
 * nothing balanced can be extracted (the value carries no further object content), only the
 * artifact key is removed — never the element's own real fields, and the element itself is never
 * evicted from the array. Either way, the vacated key surfaces to the caller's `droppedKeyPaths`
 * diff exactly as {@link hoistSectionNotes}'s relocations do; when elements were also recovered,
 * that same diff separately names the rejoin (element count and the artifact-key path it came
 * from), so recovery is `NORMALIZE-WITH-LOG`, never a silent splice — neither the recovery nor the
 * drop is silent. A key whose text is not solely structural punctuation, or a value that cannot be rejoined
 * into balanced object literals, passes through untouched so `.strict()`'s own
 * `Unrecognized key` rejection still applies — this never widens what an unknown key is allowed to
 * mean. Transparent to `z.toJSONSchema` (`io: 'input'`): this operates on the parsed JS value before
 * Zod runs, so the model-facing tool schema is unchanged.
 *
 * @param value - Raw model payload (or a nested value reached while walking it) before Zod
 * validation; anything that is not a plain object or array passes through untouched.
 * @returns The payload with every recoverable array-boundary artifact rejoined and every
 * unrecoverable one dropped, or `value` unchanged when nothing in it matches the defect shape.
 */
export function repairArrayBoundaryArtifacts(value: unknown): unknown {
  if (Array.isArray(value)) {
    const walked = value.map(repairArrayBoundaryArtifacts);
    let changed = walked.some((item, index) => item !== value[index]);
    const rebuilt: unknown[] = [];
    for (const item of walked) {
      const artifactKey = isPlainObject(item)
        ? Object.keys(item).find((key) => ARRAY_BOUNDARY_ARTIFACT_KEY.test(key))
        : undefined;
      if (!artifactKey || !isPlainObject(item)) {
        rebuilt.push(item);
        continue;
      }
      changed = true;
      const { [artifactKey]: rawValue, ...rest } = item;
      rebuilt.push(rest);
      const recovered = typeof rawValue === 'string'
        ? extractBalancedJsonObjects(`${artifactKey}"${rawValue}`)
        : null;
      if (recovered) rebuilt.push(...recovered.map(repairArrayBoundaryArtifacts));
    }
    return changed ? rebuilt : value;
  }
  if (isPlainObject(value)) {
    let changed = false;
    const next = Object.fromEntries(Object.entries(value).map(([key, entryValue]) => {
      const repaired = repairArrayBoundaryArtifacts(entryValue);
      if (repaired !== entryValue) changed = true;
      return [key, repaired];
    }));
    return changed ? next : value;
  }
  return value;
}

/**
 * A key made only of whitespace. No declared field is spelled this way; on a section that carries
 * `text`, it is where a `text` string closed early and its continuation was read as a new key.
 */
const WHITESPACE_ONLY_KEY = /^\s+$/;

/** Whether `key` on `record` is a string-boundary artifact of `record.text`. */
function isTextBoundaryArtifact(record: Record<string, unknown>, key: string): boolean {
  return WHITESPACE_ONLY_KEY.test(key) && typeof record[key] === 'string' && typeof record.text === 'string';
}

/**
 * Rejoins a top-level `sections[]` entry whose `text` closed early: each whitespace-only key with a
 * string value is appended back onto `text` as `text + key + value`, in key order, and removed.
 *
 * @remarks
 * Sibling of {@link repairArrayBoundaryArtifacts} for the string boundary inside one element rather
 * than the boundary between elements. Lossless — the key and its value are both kept in `text`.
 * `droppedKeyPaths` names each rejoin, so this is NORMALIZE-WITH-LOG. A whitespace-only key with a
 * non-string value, or on a section without a string `text`, passes through so `.strict()` still
 * rejects it; every other unknown key is untouched.
 *
 * @param value - Raw model payload before Zod validation.
 * @returns The payload with each such section's continuation rejoined, or `value` unchanged.
 */
export function rejoinSectionTextBoundaryArtifacts(value: unknown): unknown {
  if (!isPlainObject(value) || !Array.isArray(value.sections)) return value;
  let changed = false;
  const sections = value.sections.map((section) => {
    if (!isPlainObject(section)) return section;
    const keys = Object.keys(section).filter(key => isTextBoundaryArtifact(section, key));
    if (keys.length === 0) return section;
    changed = true;
    const rest: Record<string, unknown> = { ...section };
    let text = section.text as string;
    for (const key of keys) {
      text += key + (section[key] as string);
      delete rest[key];
    }
    return { ...rest, text };
  });
  return changed ? { ...value, sections } : value;
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

  const normalizeEntryIds = (list: unknown[], listName: string, key: string): unknown[] => list.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const value = (entry as Record<string, unknown>)[key];
    if (typeof value !== 'string') return entry;
    const resolved = resolveModelNodeId(value, nodeMap) ?? value;
    note(`${listName}.${index}.${key}`, value, resolved);
    return { ...(entry as Record<string, unknown>), [key]: resolved };
  });
  if (Array.isArray(rawInput.prune_neighbors)) {
    input.prune_neighbors = normalizeEntryIds(rawInput.prune_neighbors, 'prune_neighbors', 'id');
  }
  if (Array.isArray(rawInput.questions)) {
    input.questions = normalizeEntryIds(rawInput.questions, 'questions', 'nodeId');
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

  if (parts.length === 1) return { query: parts[0] };
  if (parts.length === 2) return { query: parts[1], schemaHint: parts[0] };
  if (parts.length === 3) return { query: parts[2], schemaHint: parts[1] };

  return { query: input };
}
