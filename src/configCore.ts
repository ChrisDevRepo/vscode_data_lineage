/**
 * Pure config parsing for extension startup: YAML config files and the numeric bounds of
 * `dataLineageViz.*` settings.
 *
 * No `vscode` import: `src/extension.ts` is the host wrapper that performs the
 * `vscode.workspace.fs` read plus logging and notification around these functions.
 */
import * as yaml from 'js-yaml';
import { z } from 'zod';
import { AI_SECTION_KEY_BY_ANGLE, type AiOutputSections, type AiOutputTemplates, type AiSectionAngle } from './ai/session/types';
import { contributes } from '../package.json';

/**
 * Shape of `assets/aiOutputTemplates.yaml` and any custom overlay file.
 *
 * @remarks
 * The top level carries an optional `schemaVersion` scalar alongside one entry per template
 * key. Custom overlays are hand-authored YAML, so a string like `"1"` must still parse — but the
 * `extensionRuntime.ts` gate compares it with strict `!==` against a numeric contract version, so the
 * field is coerced to a number (`"1"` → `1`) rather than a `number | string` union that would
 * always fail that comparison and silently disable the overlay. Every OTHER top-level key must be
 * a template object (`{ instruction?: string, ...extra }`) — `catchall` enforces that while
 * leaving `schemaVersion` as the one legal scalar exception. The optional `sections` field of a
 * capture recipe is read by {@link readAiOutputSections}, which validates it per key so a malformed
 * list costs only that list, never the file.
 */
const AiOutputTemplatesConfigSchema = z.object({
  schemaVersion: z.coerce.number().optional(),
}).catchall(z.object({
  instruction: z.string().optional(),
  sections: z.unknown().optional(),
}).passthrough());

/** Parsed shape of the AI-output-templates YAML — the return contract of {@link parseAiOutputTemplatesYaml}. */
export type AiOutputTemplatesConfig = z.infer<typeof AiOutputTemplatesConfigSchema>;

/** Shape of `assets/defaultParseRules.yaml` and any custom overlay file. */
const RawParseRulesYamlSchema = z.object({
  rules: z.array(z.record(z.string(), z.any())).optional(),
}).passthrough();

/**
 * Parsed shape of the parse-rules YAML — deliberately raw (`rules` entries stay untyped):
 * `sqlBodyParser.loadRules` is the per-rule validator, so this wrapper proves only the
 * file structure, never rule contents.
 */
export type RawParseRulesYaml = z.infer<typeof RawParseRulesYamlSchema>;

/**
 * The complete set of AI output template keys the extension requires — used to
 * validate both the built-in YAML and any custom overlay file.
 */
export const REQUIRED_AI_TEMPLATE_KEYS: (keyof AiOutputTemplates)[] = [
  'discovery_chat',
  'summary',
  'title',
  'intro',
  'closing',
  'highlights',
  'notes',
  'business_capture',
  'technical_capture',
  'structural_callouts',
  'structural_summary',
  'general',
  'loading_pattern',
  'column_trace_capture',
];

/** A declared section label list: non-empty, every label a non-blank string. */
const SectionLabelsSchema = z.array(z.string().trim().min(1)).min(1);

/**
 * Reads the optional `sections` label list of each capture recipe.
 *
 * @remarks
 * A recipe without the field contributes nothing. A malformed value (not a non-empty list of
 * non-blank strings) is reported in `rejected` and skipped, so the loader warns and the label list
 * from the file underneath (built-in) stays in force.
 *
 * @param parsed - A parsed templates file.
 * @returns The valid label lists per angle and the template keys whose `sections` value was rejected.
 */
export function readAiOutputSections(parsed: AiOutputTemplatesConfig | undefined): { sections: AiOutputSections; rejected: string[] } {
  const sections: Partial<Record<AiSectionAngle, readonly string[]>> = {};
  const rejected: string[] = [];
  for (const angle of Object.keys(AI_SECTION_KEY_BY_ANGLE) as AiSectionAngle[]) {
    const key = AI_SECTION_KEY_BY_ANGLE[angle];
    const declared = parsed?.[key]?.sections;
    if (declared === undefined) continue;
    const result = SectionLabelsSchema.safeParse(declared);
    if (result.success) sections[angle] = result.data;
    else rejected.push(key);
  }
  return { sections, rejected };
}

/**
 * Parses and validates raw YAML text against {@link AiOutputTemplatesConfigSchema}.
 *
 * @remarks
 * Throws on invalid input (unparsable YAML or a schema mismatch) — hard-fail,
 * no fallback; callers keep their own try/catch + notification around this call.
 */
export function parseAiOutputTemplatesYaml(text: string): AiOutputTemplatesConfig {
  const rawParsed = yaml.load(text);
  return AiOutputTemplatesConfigSchema.parse(rawParsed);
}

/**
 * Parses and validates raw YAML text against the parse-rules file schema.
 *
 * @remarks
 * Throws on invalid input (unparsable YAML or a schema mismatch) — hard-fail,
 * no fallback; callers keep their own try/catch + notification around this call.
 */
export function parseParseRulesYaml(text: string): RawParseRulesYaml {
  const rawParsed = yaml.load(text);
  return RawParseRulesYamlSchema.parse(rawParsed);
}

interface NumericSettingDeclaration {
  type?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
}

const DECLARED_SETTINGS: Readonly<Record<string, NumericSettingDeclaration>> = Object.assign(
  {},
  ...(contributes.configuration as unknown as ReadonlyArray<{ properties: Record<string, NumericSettingDeclaration> }>)
    .map(section => section.properties),
);

/**
 * Holds a numeric `dataLineageViz.*` setting to its manifest declaration: rounded when the
 * declared type is `integer`, then clamped to the declared `minimum`/`maximum`. VS Code only flags
 * a fractional or out-of-range value in the Settings UI and still returns it from
 * `WorkspaceConfiguration.get`, so the declaration is enforced where settings are read.
 *
 * @param key - Setting key without the `dataLineageViz.` prefix, e.g. `renderLimit`.
 * @param value - The configured value; `undefined` passes through.
 * @returns The value inside the declared range, or `undefined` when unset.
 */
export function clampDeclaredNumericSetting(key: string, value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return value;
  const declaration = DECLARED_SETTINGS[`dataLineageViz.${key}`];
  if (!declaration) return value;
  const { minimum = -Infinity, maximum = Infinity } = declaration;
  const whole = declaration.type === 'integer' ? Math.round(value) : value;
  return Math.min(maximum, Math.max(minimum, whole));
}

/**
 * Fallback for `dataLineageViz.ai.enabled` when the setting is absent.
 *
 * @remarks
 * Mirrors the manifest default (`package.json` → `contributes.configuration` →
 * `dataLineageViz.ai.enabled`), pinned by the settings-manifest test. Kept here rather than in
 * `src/ai/**` so reading the kill switch never pulls a module from the AI tree onto the activation path.
 */
export const DEFAULT_AI_ENABLED = true;

/** Runtime default of `dataLineageViz.mcp.enabled`: the localhost MCP server is opt-in. */
export const DEFAULT_MCP_ENABLED = false;

/** Runtime default of `dataLineageViz.mcp.port`. */
export const DEFAULT_MCP_PORT = 39217;

/** Discovery file name inside each session's private MCP directory. */
export const MCP_DISCOVERY_FILE = 'mcp-server.json';

/** The manifest `default` of a numeric `dataLineageViz.*` setting; throws for an undeclared key. */
function declaredNumericDefault(key: string): number {
  const value = DECLARED_SETTINGS[`dataLineageViz.${key}`]?.default;
  if (typeof value !== 'number') throw new Error(`dataLineageViz.${key} declares no numeric default.`);
  return value;
}

/** The minimal reader surface of a `vscode.WorkspaceConfiguration`, kept structural so this module stays host-free. */
export interface NumericSettingReader {
  get<T>(key: string): T | undefined;
}

/**
 * Reads one numeric `dataLineageViz.*` setting held to its declaration
 * ({@link clampDeclaredNumericSetting}), falling back to `fallback` when unset or not a finite
 * number — the one reader every host-side numeric setting goes through.
 *
 * @param cfg - The configuration scoped to `dataLineageViz`.
 * @param key - Setting key without the prefix, e.g. `tableStatistics.sampleSize`.
 * @param fallback - Used when the setting is unset or invalid; defaults to the manifest default.
 */
export function readDeclaredNumericSetting(
  cfg: NumericSettingReader,
  key: string,
  fallback: number = declaredNumericDefault(key),
): number {
  const value = cfg.get<unknown>(key);
  const clamped = typeof value === 'number' ? clampDeclaredNumericSetting(key, value) : undefined;
  return clamped !== undefined && Number.isFinite(clamped) ? clamped : fallback;
}
