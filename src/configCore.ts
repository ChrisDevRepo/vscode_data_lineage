/** Pure config parsing for extension startup: YAML config files and the numeric bounds of `dataLineageViz.*` settings. */
import * as yaml from 'js-yaml';
import { z } from 'zod';
import { AI_SECTION_KEY_BY_ANGLE, type AiOutputSections, type AiOutputTemplates, type AiSectionAngle } from './ai/session/types';
import { contributes } from '../package.json';

/** Shape of `assets/aiOutputTemplates.yaml` and any custom overlay file. */
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

/** Parsed shape of the parse-rules YAML — deliberately raw (`rules` entries stay untyped): `sqlBodyParser.loadRules` is the per-rule validator, so this wrapper proves only the file structure, never rule contents. */
export type RawParseRulesYaml = z.infer<typeof RawParseRulesYamlSchema>;

/** The complete set of AI output template keys the extension requires — used to validate both the built-in YAML and any custom overlay file. */
export const REQUIRED_AI_TEMPLATE_KEYS: (keyof AiOutputTemplates)[] = [
  'discovery_chat',
  'summary',
  'title',
  'intro',
  'closing',
  'highlights',
  'notes',
  'shared_capture',
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

/** Reads the optional `sections` label list of each capture recipe. */
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

/** Parses and validates raw YAML text against {@link AiOutputTemplatesConfigSchema}. */
export function parseAiOutputTemplatesYaml(text: string): AiOutputTemplatesConfig {
  const rawParsed = yaml.load(text);
  return AiOutputTemplatesConfigSchema.parse(rawParsed);
}

/** Parses and validates raw YAML text against the parse-rules file schema. */
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

/** Holds a numeric `dataLineageViz.*` setting to its manifest declaration: rounded when the declared type is `integer`, then clamped to the declared `minimum`/`maximum`. VS Code only flags a fractional or out-of-range value in the Settings UI and still returns it from `WorkspaceConfiguration.get`, so the declaration is enforced where settings are read. */
export function clampDeclaredNumericSetting(key: string, value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return value;
  const declaration = DECLARED_SETTINGS[`dataLineageViz.${key}`];
  if (!declaration) return value;
  const { minimum = -Infinity, maximum = Infinity } = declaration;
  const whole = declaration.type === 'integer' ? Math.round(value) : value;
  return Math.min(maximum, Math.max(minimum, whole));
}

/** Fallback for `dataLineageViz.ai.enabled` when the setting is absent. */
export const DEFAULT_AI_ENABLED = true;

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

/** Reads one numeric `dataLineageViz.*` setting held to its declaration ({@link clampDeclaredNumericSetting}), falling back to `fallback` when unset or not a finite number — the one reader every host-side numeric setting goes through. */
export function readDeclaredNumericSetting(
  cfg: NumericSettingReader,
  key: string,
  fallback: number = declaredNumericDefault(key),
): number {
  const value = cfg.get<unknown>(key);
  const clamped = typeof value === 'number' ? clampDeclaredNumericSetting(key, value) : undefined;
  return clamped !== undefined && Number.isFinite(clamped) ? clamped : fallback;
}
