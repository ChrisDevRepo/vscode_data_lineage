/** Unit tests for src/configCore.ts — pure YAML config parsing for extension startup. */

import { readFileSync } from 'fs';
import { describe, it, expect } from 'vitest';
import { rootPath } from '../helpers/testUtils';
import {
  clampDeclaredNumericSetting,
  parseAiOutputTemplatesYaml,
} from '../../../src/configCore';
import { AI_TEMPLATE_SCHEMA_VERSION } from '../../../src/ai/session/types';

describe('parseAiOutputTemplatesYaml (assets/aiOutputTemplates.yaml)', () => {
  const text = readFileSync(rootPath('assets/aiOutputTemplates.yaml'), 'utf-8');

  it('declares the schemaVersion the loader enforces', () => {
    expect(parseAiOutputTemplatesYaml(text).schemaVersion).toBe(
      AI_TEMPLATE_SCHEMA_VERSION,
    );
  });

  // Hand-written from the template contract; the loader's own key list is the subject, not the
  // oracle.
  const NON_EMPTY_KEYS = [
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

  it.each(NON_EMPTY_KEYS)('ships a non-blank instruction for %s', (key) => {
    const entry = (parseAiOutputTemplatesYaml(text) as Record<string, unknown>)[
      key
    ] as { instruction?: unknown } | undefined;
    expect(typeof entry?.instruction).toBe('string');
    expect(String(entry?.instruction).trim()).not.toBe('');
  });
});

describe('AiOutputTemplatesConfigSchema', () => {
  it('rejects a scalar value under a template key', () => {
    expect(() =>
      parseAiOutputTemplatesYaml(
        'schemaVersion: 1\nsummary: "just a string"\n',
      ),
    ).toThrow();
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
    expect(clampDeclaredNumericSetting('trace.defaultUpstreamLevels', -5)).toBe(
      0,
    );
  });
});
