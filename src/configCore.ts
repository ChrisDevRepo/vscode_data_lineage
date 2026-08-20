/**
 * Pure YAML→config parsing for extension-startup config files.
 *
 * No `vscode` import: `src/extension.ts` is the host wrapper that performs the
 * `vscode.workspace.fs` read plus logging and notification around these functions.
 */
import * as yaml from 'js-yaml';
import { z } from 'zod';
import type { AiOutputTemplates } from './ai/session/types';

/**
 * Shape of `assets/aiOutputTemplates.yaml` and any custom overlay file.
 *
 * @remarks
 * The top level carries an optional `schemaVersion` scalar alongside one entry per template
 * key. Custom overlays are hand-authored YAML, so a string like `"1"` must still parse — but the
 * `extension.ts` gate compares it with strict `!==` against a numeric contract version, so the
 * field is coerced to a number (`"1"` → `1`) rather than a `number | string` union that would
 * always fail that comparison and silently disable the overlay. Every OTHER top-level key must be
 * a template object (`{ instruction?: string, ...extra }`) — `catchall` enforces that while
 * leaving `schemaVersion` as the one legal scalar exception.
 */
const AiOutputTemplatesConfigSchema = z.object({
  schemaVersion: z.coerce.number().optional(),
}).catchall(z.object({
  instruction: z.string().optional(),
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
 * file structure, never rule contents. Named "raw" to avoid colliding with the strict
 * `ParseRulesConfig` in `sqlBodyParser.ts`.
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
  'structural_summary',
  'general',
  'loading_pattern',
  'column_trace_capture',
];

/**
 * Parses and validates raw YAML text against {@link AiOutputTemplatesConfigSchema}.
 *
 * @remarks
 * Throws on invalid input (unparsable YAML or a schema mismatch) — hard-fail,
 * no fallback; callers keep their own try/catch + notification around this call.
 * @param text - Raw YAML file contents.
 * @returns The validated, schema-inferred config.
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
 * @param text - Raw YAML file contents.
 * @returns The validated, schema-inferred config.
 */
export function parseParseRulesYaml(text: string): RawParseRulesYaml {
  const rawParsed = yaml.load(text);
  return RawParseRulesYamlSchema.parse(rawParsed);
}
