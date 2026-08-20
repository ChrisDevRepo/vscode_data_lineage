/**
 * Termination contract for user-supplied parse-rule regexes.
 *
 * Every consumer of `rule.pattern` scans or rewrites the whole SQL body, so the global flag is a
 * termination condition rather than a style preference: `extractExternalRefs` scans with `exec` and
 * would never advance `lastIndex`, and a preprocessing `replace` would rewrite only the first
 * occurrence. `validateRule` is the single place that can reject the rule before either happens.
 */

import { readFileSync } from 'fs';
import * as yaml from 'js-yaml';
import { describe, it, expect, afterAll } from 'vitest';
import { loadRules, extractExternalRefs, type RawParseRulesConfig } from '../../../src/engine/sqlBodyParser';
import { loadParseRules, rootPath } from '../helpers/testUtils';

/** Restores the shipped rule set — `loadRules` replaces a module-global. */
afterAll(() => {
  loadParseRules();
});

function externalRefRule(flags: string): RawParseRulesConfig {
  return {
    rules: [{
      name: 'scan_openrowset',
      enabled: true,
      priority: 50,
      category: 'external_ref',
      kind: 'openrowset',
      pattern: "\\bOPENROWSET\\s*\\(\\s*BULK\\s+'([^']+)'",
      flags,
      description: 'test rule',
    }],
  };
}

describe('parse rule regex flags', () => {
  it('rejects a rule whose flags omit the global flag', () => {
    const result = loadRules(externalRefRule('i'));

    expect(result.loaded).toBe(0);
    expect(result.skipped).toEqual(['scan_openrowset']);
    expect(result.errors[0]).toContain('scan_openrowset');
    expect(result.errors[0]).toContain("must include 'g'");
    // Rejecting the only rule leaves no rule set, which is the existing fallback contract.
    expect(result.usedDefaults).toBe(true);
  });

  it('rejects empty flags for the same reason', () => {
    const result = loadRules(externalRefRule(''));

    expect(result.loaded).toBe(0);
    expect(result.errors[0]).toContain("must include 'g'");
  });

  it('accepts the same rule once the global flag is present', () => {
    const result = loadRules(externalRefRule('gi'));

    expect(result.loaded).toBe(1);
    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('leaves every shipped rule loadable', () => {
    const result = loadParseRulesResult();

    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.usedDefaults).toBe(false);
    expect(result.loaded).toBeGreaterThan(0);
  });
});

describe('extractExternalRefs', () => {
  it('terminates and deduplicates over a body with many matches', () => {
    loadRules(externalRefRule('gi'));
    const body = Array.from(
      { length: 5000 },
      (_, i) => `SELECT * FROM OPENROWSET(BULK 'https://acct.blob.core.windows.net/d/f${i}.parquet', FORMAT='PARQUET') AS r${i}`,
    ).join('\n');

    const refs = extractExternalRefs(body);

    expect(refs).toHaveLength(5000);
    expect(refs[0].kind).toBe('openrowset');
    expect(new Set(refs.map(r => r.url)).size).toBe(5000);
  });

  it('reports a repeated reference once', () => {
    loadRules(externalRefRule('gi'));
    const line = "SELECT * FROM OPENROWSET(BULK 'https://acct.blob.core.windows.net/d/same.parquet', FORMAT='PARQUET') AS r";

    const refs = extractExternalRefs(`${line}\n${line}\n${line}`);

    expect(refs).toHaveLength(1);
    expect(refs[0].url).toContain('same.parquet');
  });
});

/** Loads the shipped YAML through the same entry point and returns its diagnostics. */
function loadParseRulesResult() {
  const rulesYaml = readFileSync(rootPath('assets/defaultParseRules.yaml'), 'utf-8');
  return loadRules(yaml.load(rulesYaml) as RawParseRulesConfig);
}
