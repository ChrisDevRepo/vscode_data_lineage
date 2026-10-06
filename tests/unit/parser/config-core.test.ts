/**
 * Unit tests for src/configCore.ts — pure YAML config parsing for extension startup.
 *
 * Covers:
 *   parseAiOutputTemplatesYaml — real assets/aiOutputTemplates.yaml parses; every
 *     REQUIRED_AI_TEMPLATE_KEYS entry present with a non-empty instruction; schemaVersion
 *     readable; negative cases (scalar-under-key rejected, bare schemaVersion accepted)
 *   parseParseRulesYaml — real assets/defaultParseRules.yaml parses with a non-empty rules[]
 *   clampDeclaredNumericSetting — numeric settings are held to their package.json min/max
 */

import { readFileSync } from 'fs';
import { describe, it, expect } from 'vitest';
import { rootPath } from '../helpers/testUtils';
import {
  clampDeclaredNumericSetting,
  readDeclaredNumericSetting,
  parseAiOutputTemplatesYaml,
  parseParseRulesYaml,
  REQUIRED_AI_TEMPLATE_KEYS,
} from '../../../src/configCore';
import { AI_TEMPLATE_SCHEMA_VERSION } from '../../../src/ai/session/types';

describe('parseAiOutputTemplatesYaml (assets/aiOutputTemplates.yaml)', () => {
  const text = readFileSync(rootPath('assets/aiOutputTemplates.yaml'), 'utf-8');

  it('parses the built-in file without throwing', () => {
    expect(() => parseAiOutputTemplatesYaml(text)).not.toThrow();
    expect(parseAiOutputTemplatesYaml(text)).toBeDefined();
  });

  it('declares the schemaVersion the loader enforces', () => {
    expect(parseAiOutputTemplatesYaml(text).schemaVersion).toBe(AI_TEMPLATE_SCHEMA_VERSION);
  });

  it('carries every required key with a non-empty string instruction', () => {
    const parsed = parseAiOutputTemplatesYaml(text) as Record<string, unknown>;
    for (const key of REQUIRED_AI_TEMPLATE_KEYS) {
      const entry = parsed[key] as { instruction?: string } | undefined;
      expect(entry, `required key '${key}' present`).toBeTruthy();
      expect(typeof entry?.instruction, `required key '${key}' has a string instruction`).toBe('string');
      expect((entry?.instruction ?? '').trim().length, `required key '${key}' instruction non-empty`).toBeGreaterThan(0);
    }
  });


});

describe('parseParseRulesYaml (assets/defaultParseRules.yaml)', () => {
  const text = readFileSync(rootPath('assets/defaultParseRules.yaml'), 'utf-8');

  it('parses the built-in file without throwing', () => {
    expect(() => parseParseRulesYaml(text)).not.toThrow();
  });

  it('yields the full shipped rule inventory', () => {
    const parsed = parseParseRulesYaml(text);
    expect(parsed.rules?.map(rule => rule.name).sort()).toEqual([
      'clean_sql',
      'extract_bulk_from',
      'extract_bulk_insert',
      'extract_cetas',
      'extract_copy_from',
      'extract_copy_into',
      'extract_ctas',
      'extract_merge_using',
      'extract_openrowset',
      'extract_output_into',
      'extract_select_into',
      'extract_sources_ansi',
      'extract_sources_tsql_apply',
      'extract_sp_calls',
      'extract_targets_dml',
      'extract_udf_calls',
      'extract_update_alias_target',
    ]);
  });

  it('gives every shipped rule a global regex flag', () => {
    const parsed = parseParseRulesYaml(text);
    for (const rule of parsed.rules ?? []) {
      expect(rule.flags, `${rule.name} flags`).toContain('g');
    }
  });
});

describe('AiOutputTemplatesConfigSchema negative/positive cases', () => {
  it('rejects a scalar value under a template key', () => {
    expect(() => parseAiOutputTemplatesYaml('schemaVersion: 1\nsummary: "just a string"\n')).toThrow();
  });

  it('accepts a bare top-level schemaVersion scalar and round-trips it', () => {
    let parsed: ReturnType<typeof parseAiOutputTemplatesYaml> | undefined;
    expect(() => { parsed = parseAiOutputTemplatesYaml('schemaVersion: 2\n'); }).not.toThrow();
    expect(parsed?.schemaVersion).toBe(2);
  });

  it('coerces a string schemaVersion "1" to numeric 1', () => {
    let parsed: ReturnType<typeof parseAiOutputTemplatesYaml> | undefined;
    expect(() => { parsed = parseAiOutputTemplatesYaml('schemaVersion: "1"\n'); }).not.toThrow();
    expect(parsed?.schemaVersion).toBe(1);
  });
});

describe('overlay example in docs/AI_PROMPTS.md', () => {
  it('parses as an overlay and carries a string instruction under each key it sets', () => {
    const doc = readFileSync(rootPath('docs/AI_PROMPTS.md'), 'utf-8');
    const example = /Example — guidance for a junior DBA[\s\S]*?```yaml\n([\s\S]*?)```/.exec(doc)?.[1];
    expect(example, 'the junior-DBA overlay example is present').toBeDefined();

    const parsed = parseAiOutputTemplatesYaml(`schemaVersion: ${AI_TEMPLATE_SCHEMA_VERSION}\n${example}`) as Record<string, { instruction?: unknown }>;
    const keys = Object.keys(parsed).filter((key) => key !== 'schemaVersion');

    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(REQUIRED_AI_TEMPLATE_KEYS as string[], `'${key}' is a template key`).toContain(key);
      expect(typeof parsed[key].instruction, `'${key}' sets instruction, the only field the loader reads`).toBe('string');
    }
  });
});

describe('clampDeclaredNumericSetting', () => {
  it('holds a value above the declared maximum at the maximum', () => {
    expect(clampDeclaredNumericSetting('maxNodes', 11000)).toBe(5000);
    expect(clampDeclaredNumericSetting('renderLimit', 10000)).toBe(1500);
    expect(clampDeclaredNumericSetting('overview.threshold', 10000)).toBe(1000);
  });

  it('holds a value below the declared minimum at the minimum', () => {
    expect(clampDeclaredNumericSetting('maxNodes', 1)).toBe(10);
    expect(clampDeclaredNumericSetting('trace.defaultUpstreamLevels', -5)).toBe(0);
  });

  it('rounds a fractional value of an integer setting', () => {
    expect(clampDeclaredNumericSetting('tableStatistics.sampleSize', 1000.5)).toBe(1001);
    expect(clampDeclaredNumericSetting('trace.defaultUpstreamLevels', 2.4)).toBe(2);
  });

  it('reads through readDeclaredNumericSetting with the manifest default for an unset or non-numeric value', () => {
    const cfg = (value: unknown) => ({ get: <T,>() => value as T | undefined });
    expect(readDeclaredNumericSetting(cfg(undefined), 'renderLimit')).toBe(750);
    expect(readDeclaredNumericSetting(cfg('1000'), 'renderLimit')).toBe(750);
    expect(readDeclaredNumericSetting(cfg(99999), 'renderLimit')).toBe(1500);
  });

  it('passes an in-range value, an unset value and an undeclared key through unchanged', () => {
    expect(clampDeclaredNumericSetting('renderLimit', 750)).toBe(750);
    expect(clampDeclaredNumericSetting('renderLimit', undefined)).toBeUndefined();
    expect(clampDeclaredNumericSetting('notDeclared', 123456)).toBe(123456);
  });
});
