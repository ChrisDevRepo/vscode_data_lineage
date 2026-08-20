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

  // Pinned to the constant, not a literal: the built-in file must always satisfy its own overlay
  // gate, and a release that bumps one without the other would reject every custom overlay —
  // including correctly updated ones. A literal here would instead fail on every legitimate bump.
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
    expect(instruction).toContain("Lead with the direct answer to the user's question");
    expect(instruction).toContain('transformations and column mappings');
    expect(instruction).toContain('error and audit paths');
    expect(instruction).toContain('Keep internal tool names, call syntax, and payload fields out');
    expect(instruction).toContain('raw node/edge inventory only');
  });

  it('keeps structural_summary free of ## headings reserved for the engine wrapper', () => {
    const instruction = parseAiOutputTemplatesYaml(text).structural_summary?.instruction ?? '';
    expect(instruction).not.toMatch(/^##\s/m);
  });

  it('tells structural_summary to submit one section per angle under classification=both', () => {
    const instruction = parseAiOutputTemplatesYaml(text).structural_summary?.instruction ?? '';
    expect(instruction).toContain('one section per angle');
  });

  // The renderer gates `closing` on captured slot count (CLOSING_MIN_SLOTS), never on authored
  // section count — a "5+ sections" claim describes a quantity the code does not measure.
  it('keeps the closing template free of section-count claims', () => {
    const instruction = parseAiOutputTemplatesYaml(text).closing?.instruction ?? '';
    expect(instruction).not.toMatch(/\d\+? sections/);
    expect(instruction).toContain('Required whenever this template appears');
  });

  // `closing` is suppressed below CLOSING_MIN_SLOTS while loading_pattern is not slot-gated, so
  // the ETL statement needs a landing spot that exists in every rendering combination.
  it('gives loading_pattern a fallback destination when closing is suppressed', () => {
    const instruction = parseAiOutputTemplatesYaml(text).loading_pattern?.instruction ?? '';
    expect(instruction).toContain('otherwise in the section that covers the load');
    expect(instruction).not.toContain('in the closing note');
  });

  // column_trace_capture renders in the stable prefix while the capture recipes are per-focus
  // (PER_FOCUS_KEYS): on a non-bodied CT hop the referenced recipes do not render, so the
  // checklist must name the field, not another template.
  it('keeps column_trace_capture free of cross-template references', () => {
    const instruction = parseAiOutputTemplatesYaml(text).column_trace_capture?.instruction ?? '';
    expect(instruction).not.toContain('business/technical capture');
    expect(instruction).toContain("this hop's narrative body");
  });
});

describe('parseParseRulesYaml (assets/defaultParseRules.yaml)', () => {
  const text = readFileSync(rootPath('assets/defaultParseRules.yaml'), 'utf-8');

  it('parses the built-in file without throwing', () => {
    expect(() => parseParseRulesYaml(text)).not.toThrow();
  });

  it('yields a non-empty rules array', () => {
    const parsed = parseParseRulesYaml(text);
    expect(Array.isArray(parsed.rules)).toBe(true);
    expect(parsed.rules?.length ?? 0).toBeGreaterThan(0);
  });
});

describe('AiOutputTemplatesConfigSchema negative/positive cases', () => {
  it('rejects a scalar value under a template key', () => {
    // A top-level scalar under a non-schemaVersion key must still reject (every key but
    // schemaVersion must be a template object).
    expect(() => parseAiOutputTemplatesYaml('schemaVersion: 1\nsummary: "just a string"\n')).toThrow();
  });

  it('accepts a bare top-level schemaVersion scalar and round-trips it', () => {
    // A bare top-level schemaVersion scalar must parse cleanly.
    let parsed: ReturnType<typeof parseAiOutputTemplatesYaml> | undefined;
    expect(() => { parsed = parseAiOutputTemplatesYaml('schemaVersion: 2\n'); }).not.toThrow();
    expect(parsed?.schemaVersion).toBe(2);
  });

  it('coerces a string schemaVersion "1" to numeric 1', () => {
    // A hand-authored string schemaVersion must coerce to a number so the extension.ts `!==`
    // gate (strict compare against the numeric contract version) matches instead of silently
    // disabling the overlay.
    let parsed: ReturnType<typeof parseAiOutputTemplatesYaml> | undefined;
    expect(() => { parsed = parseAiOutputTemplatesYaml('schemaVersion: "1"\n'); }).not.toThrow();
    expect(parsed?.schemaVersion).toBe(1);
  });
});
