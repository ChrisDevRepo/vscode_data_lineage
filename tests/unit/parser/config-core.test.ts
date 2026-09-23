/**
 * Unit tests for src/configCore.ts — pure YAML config parsing for extension startup.
 *
 * Covers:
 *   parseAiOutputTemplatesYaml — real assets/aiOutputTemplates.yaml parses; every
 *     REQUIRED_AI_TEMPLATE_KEYS entry present with a non-empty instruction; schemaVersion
 *     readable; negative cases (scalar-under-key rejected, bare schemaVersion accepted)
 *   parseParseRulesYaml — real assets/defaultParseRules.yaml parses with a non-empty rules[]
 */

import { readFileSync } from 'fs';
import { describe, it, expect } from 'vitest';
import { rootPath } from '../helpers/testUtils';
import {
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

  it('keeps discovery answers question-first instead of emitting raw tool inventories', () => {
    const instruction = parseAiOutputTemplatesYaml(text).discovery_chat?.instruction ?? '';
    expect(instruction).toContain('Lead with the direct answer.');
    expect(instruction).toContain('transformations, column mappings');
    expect(instruction).not.toContain('error and audit paths');
    expect(instruction).toContain('Keep tool names and payload fields out of the answer');
    expect(instruction).toContain('list raw nodes or edges only when asked');
  });

  it('keeps structural_summary free of ## headings reserved for the engine wrapper', () => {
    const instruction = parseAiOutputTemplatesYaml(text).structural_summary?.instruction ?? '';
    expect(instruction).not.toMatch(/^##\s/m);
  });

  it('keeps the closing template free of section-count claims', () => {
    const instruction = parseAiOutputTemplatesYaml(text).closing?.instruction ?? '';
    expect(instruction).not.toMatch(/\d\+? sections/);
  });

  it('gives loading_pattern a fallback destination when closing is suppressed', () => {
    const instruction = parseAiOutputTemplatesYaml(text).loading_pattern?.instruction ?? '';
    expect(instruction).toContain('else in the section covering the load');
    expect(instruction).not.toContain('in the closing note');
  });

  it('keeps column_trace_capture free of cross-template references', () => {
    const instruction = parseAiOutputTemplatesYaml(text).column_trace_capture?.instruction ?? '';
    expect(instruction).not.toContain('business/technical capture');
    expect(instruction).toContain("this hop's narrative body");
  });

  it('does not restate $$ producing expressions in column_trace_capture', () => {
    const instruction = parseAiOutputTemplatesYaml(text).column_trace_capture?.instruction ?? '';
    expect(instruction).not.toContain('$$');
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
