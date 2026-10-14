import { readFileSync } from 'fs';
import * as yaml from 'js-yaml';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadRules, parseSqlBody } from '../../../src/engine/sqlBodyParser';
import { loadParseRules, rootPath } from '../helpers/testUtils';

beforeAll(() => loadParseRules());
afterAll(() => loadParseRules());

it('resolves the alias under a custom rule file that keeps the 1.2.3 pattern, whose capture is the FROM table', () => {
  const config = yaml.load(readFileSync(rootPath('assets/defaultParseRules.yaml'), 'utf-8')) as { rules: Array<{ name: string; pattern: string }> };
  const rule = config.rules.find(candidate => candidate.name === 'extract_update_alias_target')!;
  rule.pattern = '\\bUPDATE\\s+(?!\\[?[\\p{L}_@#][\\p{L}\\p{Nd}_@$#]*\\]?\\s*\\.)\\[?[\\p{L}_@#][\\p{L}\\p{Nd}_@$#]*\\]?\\s+SET\\b(?:(?!\\bFROM\\b|\\bSELECT\\b)[^;]){0,3000}?\\bFROM\\s+((?:(?:\\[(?:[^\\]]|\\]\\])+\\]|[\\p{L}_@#][\\p{L}\\p{Nd}_@$#]*)\\.)*(?:\\[(?:[^\\]]|\\]\\])+\\]|[\\p{L}_@#][\\p{L}\\p{Nd}_@$#]*))(?:(?<=\\])(?![\\].])|(?=$|[\\s,;()]))';
  expect(loadRules(config).errors).toEqual([]);
  try {
    expect(parseSqlBody('UPDATE t SET t.Value = s.Value FROM dbo.Source s JOIN dbo.Target t ON t.Id = s.Id').targets)
      .toEqual(['[dbo].[target]']);
  } finally {
    loadParseRules();
  }
});
