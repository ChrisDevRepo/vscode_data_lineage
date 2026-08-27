import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { structureDiff, structureFingerprint, templateStructure } from '../../tools/templateStructure.mjs';

const BASE = `
schemaVersion: 2
summary:
  stages: [synthesis]
  instruction: >
    One-line graph purpose.
  example: "Revenue lineage."
title:
  stages: [synthesis]
  instruction: Optional.
`;

describe('templateStructure — schema-version gate fingerprint', () => {
  it('ignores schemaVersion and prose, records fields and value types', () => {
    expect(templateStructure(BASE)).toEqual({
      summary: { example: 'string', instruction: 'string', stages: 'array' },
      title: { instruction: 'string', stages: 'array' },
    });
  });

  it('wording-only edits keep the fingerprint (content never bumps)', () => {
    const reworded = BASE
      .replace('One-line graph purpose.', 'Two sentences naming the pipeline purpose.')
      .replace('Optional.', 'Required — aim for 80 chars.')
      .replace('"Revenue lineage."', '"Order lineage to FactTableA."');
    expect(structureFingerprint(reworded)).toBe(structureFingerprint(BASE));
    expect(structureDiff(templateStructure(BASE), templateStructure(reworded))).toEqual([]);
  });

  it('a renamed template, an added field, or a retyped field changes the fingerprint (structure bumps)', () => {
    const renamed = BASE.replace('\ntitle:', '\nheadline:');
    expect(structureDiff(templateStructure(BASE), templateStructure(renamed))).toEqual([
      '+ headline (new template)',
      '- title (template removed)',
    ]);
    const added = BASE.replace('  instruction: Optional.', '  instruction: Optional.\n  maxLength: 120');
    expect(structureDiff(templateStructure(BASE), templateStructure(added))).toEqual(['+ title.maxLength: number']);
    const retyped = BASE.replace('stages: [synthesis]\n  instruction: Optional.', 'stages: synthesis\n  instruction: Optional.');
    expect(structureDiff(templateStructure(BASE), templateStructure(retyped))).toEqual(['~ title.stages: array → string']);
  });

  it('rejects a document that is not a mapping', () => {
    expect(() => templateStructure('- a\n- b\n')).toThrow('mapping');
  });

  it('fingerprints the shipped asset and is whitespace independent', () => {
    const asset = readFileSync('assets/aiOutputTemplates.yaml', 'utf8');
    const structure = templateStructure(asset);
    expect(Object.keys(structure)).toContain('business_capture');
    expect(structure.business_capture.instruction).toBe('string');
    expect(structureFingerprint(`${asset}\n\n`)).toBe(structureFingerprint(asset));
  });
});
