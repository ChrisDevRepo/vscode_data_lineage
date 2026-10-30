/** Custom-rule isolation and the shared comment-mask/search contract; static SQL lives in the catalog. */
import { readFileSync } from 'node:fs';
import * as yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildModel } from '../../../src/engine/modelBuilder';
import { loadRules, parseSqlBody } from '../../../src/engine/sqlBodyParser';
import {
  SQL_CODE,
  SQL_LINE_COMMENT,
  sqlCommentMask,
} from '../../../src/engine/shared/sqlSpans';
import { searchBodyScripts } from '../../../src/utils/modelSearch';
import { loadParseRules, rootPath } from '../helpers/testUtils';

beforeEach(() => {
  loadParseRules();
});
afterEach(() => {
  loadParseRules();
});

const subject = 'gen.Subject';
const key = (name: string, cs: boolean) =>
  name
    .split('.')
    .map((part) => `[${cs ? part : part.toLowerCase()}]`)
    .join('.');
const edge = (
  source: string,
  target: string,
  cs: boolean,
  removal = false,
) => ({
  source: key(source, cs),
  target: key(target, cs),
  type: 'body',
  ...(removal ? { deleteOnly: true } : {}),
});
const sorted = <T>(items: T[]) =>
  [...items].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
function graph(sql: string, cs: boolean) {
  const objects = [
    { fullName: subject, type: 'procedure' as const, bodyScript: sql },
    { fullName: 'dbo.TargetC', type: 'table' as const },
  ];
  return sorted(
    buildModel(
      objects,
      [{ sourceName: subject, targetName: 'dbo.TargetC' }],
      objects,
      'LocalDb',
      true,
      undefined,
      cs,
    ).edges.map(({ source, target, type, deleteOnly }) => ({
      source,
      target,
      type,
      ...(deleteOnly ? { deleteOnly: true } : {}),
    })),
  );
}
function configuredRules() {
  return yaml.load(
    readFileSync(rootPath('assets/defaultParseRules.yaml'), 'utf8'),
  ) as { rules: Array<Record<string, unknown>> };
}

describe.each([false, true])(
  'custom rules preserve independent physical mutations (CS=%s)',
  (cs) => {
    it('preserves native mutation direction when configured target extraction is disabled', () => {
      const rules = configuredRules();
      for (const rule of rules.rules)
        if (rule.category === 'target') rule.enabled = false;
      expect(loadRules(rules).errors).toEqual([]);
      const sql = 'UPDATE dbo.TargetC SET ID=1;';
      expect(parseSqlBody(sql).targets).toEqual([]);
      expect(graph(sql, cs)).toEqual([edge(subject, 'dbo.TargetC', cs)]);
    });

    it('preserves configured dependencies while capturing physical removal before custom rewrite', () => {
      const rules = configuredRules();
      rules.rules.push({
        name: 'review_delete_as_select',
        enabled: true,
        priority: 2,
        category: 'preprocessing',
        pattern: '\\bDELETE\\s+FROM\\s+',
        flags: 'gi',
        replacement: 'SELECT * FROM ',
        description:
          'Configured dependency rewrite; physical SQL remains DELETE.',
      });
      expect(loadRules(rules).errors).toEqual([]);
      const sql = 'DELETE FROM dbo.TargetC;';
      expect(parseSqlBody(sql, undefined, cs).sources).toEqual([
        key('dbo.TargetC', cs),
      ]);
      expect(graph(sql, cs)).toEqual(
        sorted([
          edge('dbo.TargetC', subject, cs),
          edge(subject, 'dbo.TargetC', cs, true),
        ]),
      );
    });

    it('preserves custom configured target meaning independently of physical mutations', () => {
      const rules = configuredRules();
      rules.rules.push({
        name: 'review_select_target',
        enabled: true,
        priority: 80,
        category: 'target',
        pattern: '\\bFROM\\s+(dbo\\.TargetC)',
        flags: 'gi',
        description: 'User-configured target classification.',
      });
      expect(loadRules(rules).errors).toEqual([]);
      const sql = 'SELECT ID FROM dbo.TargetC;';
      expect(parseSqlBody(sql, undefined, cs).targets).toEqual([
        key('dbo.TargetC', cs),
      ]);
      expect(parseSqlBody(sql, undefined, cs)).toHaveProperty('mutations', []);
      expect(graph(sql, cs)).toEqual(
        sorted([
          edge('dbo.TargetC', subject, cs),
          edge(subject, 'dbo.TargetC', cs),
        ]),
      );
    });
  },
);

it.each(['\n', '\r\n', '\r'])(
  'shares newline termination with raw DDL search for %j',
  (newline) => {
    const comment = '-- ignored',
      sql = comment + newline + 'SELECT Target FROM dbo.Real;';
    const mask = sqlCommentMask(sql);
    expect(Array.from(mask)).toEqual([
      ...Array<number>(comment.length).fill(SQL_LINE_COMMENT),
      ...Array<number>(sql.length - comment.length).fill(SQL_CODE),
    ]);
    const hits = searchBodyScripts(
      [
        {
          id: subject,
          schema: 'gen',
          name: 'Subject',
          type: 'procedure',
          bodyScript: sql,
        },
      ],
      /Target/g,
    );
    expect(hits.map((hit) => hit.commented ?? false)).toEqual([false]);
  },
);
