/** Termination contract for user-supplied parse-rule regexes. */

import { readFileSync } from 'fs';
import * as yaml from 'js-yaml';
import { describe, it, expect, afterAll } from 'vitest';
import {
  loadRules,
  extractExternalRefs,
  parseSqlBody,
  type RawParseRulesConfig,
} from '../../../src/engine/sqlBodyParser';
import { loadParseRules, rootPath } from '../helpers/testUtils';

/** Restores the shipped rule set — `loadRules` replaces a module-global. */
afterAll(() => {
  loadParseRules();
});

function externalRefRule(
  flags: string,
  pattern = "\\bOPENROWSET\\s*\\(\\s*BULK\\s+'([^']+)'",
): RawParseRulesConfig {
  return {
    rules: [
      {
        name: 'scan_openrowset',
        enabled: true,
        priority: 50,
        category: 'external_ref',
        kind: 'openrowset',
        pattern,
        flags,
        description: 'test rule',
      },
    ],
  };
}

describe('parse rule regex flags', () => {
  it.each(['i', ''])('rejects non-global flags %j', (flags) => {
    const result = loadRules(externalRefRule(flags));

    expect(result.loaded).toBe(0);
    expect(result.skipped).toEqual(['scan_openrowset']);
    expect(result.errors[0]).toContain('scan_openrowset');
    expect(result.errors[0]).toContain("must include 'g'");
    expect(result.usedFallback).toBe(false);
  });

  it.each(['g', 'gu', 'gv'])(
    'advances zero-width matches through Unicode SQL under flags=%s',
    (flags) => {
      const result = loadRules({
        rules: [
          {
            name: 'conditional_zero_width',
            priority: 1,
            category: 'source',
            pattern: '\\bFROM\\s+(\\w+\\.\\w+)|(?=.)|(?<=X)$',
            flags,
            description:
              'Captures a reference alongside conditional zero-width branches.',
          },
        ],
      });
      expect(result.loaded).toBe(1);
      expect(parseSqlBody('🚀 SELECT * FROM dbo.Match;X').sources).toEqual([
        '[dbo].[match]',
      ]);
    },
  );

  it('retains the validated global rule when the caller reuses its configuration object', () => {
    const rule = {
      name: 'snapshot_source',
      priority: 1,
      category: 'source',
      pattern: '\\bFROM\\s+(\\w+\\.\\w+)',
      flags: 'g',
      description: 'Source references.',
    };
    expect(loadRules({ rules: [rule] }).loaded).toBe(1);
    rule.flags = 'i';
    expect(
      parseSqlBody('SELECT * FROM dbo.First; SELECT * FROM dbo.Last;').sources,
    ).toEqual(['[dbo].[first]', '[dbo].[last]']);
  });

  const valid = externalRefRule('gi').rules![0] as unknown as Record<
    string,
    unknown
  >;
  it.each([
    ['not an object', 'x', 'not an object'],
    ['a missing name', { ...valid, name: '' }, "missing 'name'"],
    ['a missing pattern', { ...valid, pattern: '' }, "missing 'pattern'"],
    [
      'an unknown category',
      { ...valid, category: 'sink' },
      "invalid category 'sink'",
    ],
    [
      'an external_ref rule without kind',
      { ...valid, kind: '' },
      "require a non-empty 'kind'",
    ],
    [
      'a missing priority',
      { ...valid, priority: '50' },
      "missing or invalid 'priority'",
    ],
    ['missing flags', { ...valid, flags: undefined }, "missing 'flags'"],
    [
      'an empty-matching pattern',
      { ...valid, pattern: 'a*' },
      'matches empty string',
    ],
    ['an uncompilable pattern', { ...valid, pattern: '(' }, 'invalid regex'],
  ])('rejects %s', (_title, rule, error) => {
    const result = loadRules({
      rules: [rule],
    } as unknown as RawParseRulesConfig);

    expect(result.loaded).toBe(0);
    expect(result.errors[0]).toContain(error);
  });

  it('leaves no rule active when the rules array is missing and no fallback is given', () => {
    const result = loadRules({} as RawParseRulesConfig);

    expect(result.errors).toEqual(['YAML missing "rules" array']);
    expect(result.loaded).toBe(0);
    expect(result.usedFallback).toBe(false);
    expect(parseSqlBody('SELECT * FROM dbo.T').sources).toEqual([]);
  });

  it('activates the fallback rules when the configuration holds no valid rule', () => {
    const fallback = externalRefRule('gi');
    const result = loadRules(externalRefRule('i'), fallback);

    expect(result.usedFallback).toBe(true);
    expect(result.loaded).toBe(1);
    expect(result.skipped).toEqual(['scan_openrowset']);
    expect(result.errors).toEqual([
      expect.stringContaining("must include 'g'"),
      'No valid rules found',
    ]);
    expect(
      extractExternalRefs(
        "SELECT * FROM OPENROWSET(BULK 'https://a.example/f.parquet') AS r",
      ),
    ).toHaveLength(1);
  });

  it('accepts the same rule once the global flag is present and ignores the fallback', () => {
    expect(loadRules(externalRefRule('gi'), { rules: [] })).toEqual({
      loaded: 1,
      skipped: [],
      errors: [],
      usedFallback: false,
    });
  });

  it('leaves every shipped rule loadable', () => {
    const result = loadParseRulesResult();

    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.usedFallback).toBe(false);
    expect(
      result.loaded,
      'every rule in the shipped file is enabled and loads',
    ).toBe(shippedRules().length);
  });
});

describe('extractExternalRefs', () => {
  it('consumes external_ref rules only as external references', () => {
    expect(
      loadRules(externalRefRule('g', '\\bFROM\\s+(dbo\\.\\w+)')).loaded,
    ).toBe(1);
    const sql = 'SELECT * FROM dbo.FileSource;';
    expect(extractExternalRefs(sql)).toEqual([
      { url: 'dbo.FileSource', kind: 'openrowset' },
    ]);
    expect(parseSqlBody(sql)).toEqual({
      sources: [],
      targets: [],
      execCalls: [],
      crossDbSources: [],
      crossDbTargets: [],
      mutations: [],
      unsupported: [],
    });
  });

  it('keeps custom rules matching quoted paths while ignoring quoted identifiers', () => {
    const config = externalRefRule('g', "'(https://[^']+)'");
    expect(loadRules(config).errors).toEqual([]);
    expect(
      extractExternalRefs(
        "SELECT [ref 'https://phantom.example'], 'https://real.example/data.csv';",
      ),
    ).toEqual([{ url: 'https://real.example/data.csv', kind: 'openrowset' }]);
  });

  it('terminates and keeps every distinct reference over a body with many matches', () => {
    loadRules(externalRefRule('gi'));
    const body = Array.from(
      { length: 5000 },
      (_, i) =>
        `SELECT * FROM OPENROWSET(BULK 'https://acct.blob.core.windows.net/d/f${i}.parquet', FORMAT='PARQUET') AS r${i}`,
    ).join('\n');

    expect(extractExternalRefs(body)).toEqual(
      Array.from({ length: 5000 }, (_, i) => ({
        url: `https://acct.blob.core.windows.net/d/f${i}.parquet`,
        kind: 'openrowset',
      })),
    );
  });

  it('reports a repeated reference once', () => {
    loadRules(externalRefRule('gi'));
    const line =
      "SELECT * FROM OPENROWSET(BULK 'https://acct.blob.core.windows.net/d/same.parquet', FORMAT='PARQUET') AS r";

    expect(extractExternalRefs(`${line}\n${line}\n${line}`)).toEqual([
      {
        url: 'https://acct.blob.core.windows.net/d/same.parquet',
        kind: 'openrowset',
      },
    ]);
  });
});

/** The shipped rule file as written, read without the engine. */
function shippedConfig(): RawParseRulesConfig {
  return yaml.load(
    readFileSync(rootPath('assets/defaultParseRules.yaml'), 'utf-8'),
  ) as RawParseRulesConfig;
}

/** Every rule entry in the shipped file. */
function shippedRules(): unknown[] {
  return (shippedConfig() as { rules: unknown[] }).rules;
}

/** Loads the shipped YAML through the same entry point and returns its diagnostics. */
function loadParseRulesResult() {
  return loadRules(shippedConfig());
}
