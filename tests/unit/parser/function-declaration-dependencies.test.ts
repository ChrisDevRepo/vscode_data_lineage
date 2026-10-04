/** Function signatures declare names; executable scalar/TVF calls remain read dependencies. */
import { describe, expect, it } from 'vitest';
import { parseSqlBody } from '../../../src/engine/sqlBodyParser';
import { loadParseRules } from '../helpers/testUtils';

loadParseRules();
describe('function declaration dependency boundaries', () => {
  it.each(['CREATE FUNCTION', 'CREATE OR ALTER FUNCTION', 'ALTER FUNCTION', 'cReAtE\n/* signature */FuNcTiOn'])('%s does not read its declared name', declaration => {
    const sql = `${declaration} [dbo].[Declared] (@amount decimal(18,2), @multiplier int = 2) RETURNS decimal(18,2) AS BEGIN RETURN @amount * @multiplier; END;`;
    expect(parseSqlBody(sql).sources).toEqual([]);
    expect(parseSqlBody(sql).targets).toEqual([]);
    expect(parseSqlBody(sql).crossDbSources).toEqual([]);
  });
  it.each(['[dbo].[Declared]', '"dbo"."Declared"', '[a.b].[Decl]]ared]'])('preserves real calls after a %s declaration', name => {
    const sql = `CREATE OR ALTER FUNCTION ${name} (@amount int) RETURNS int AS BEGIN RETURN dbo.Calc(@amount) + ${name}(@amount - 1); END;`;
    const parsed = parseSqlBody(sql);
    expect(parsed.sources).toHaveLength(2);
    expect(parsed.sources).toContain('[dbo].[calc]');
  });
  it('retains TVF body sources and scalar calls without inventing parameter dependencies', () => {
    const parsed = parseSqlBody('CREATE FUNCTION dbo.Rows(@customer int) RETURNS TABLE AS RETURN SELECT dbo.Rate(t.Amount) AS Total FROM dbo.Orders t WHERE t.CustomerID = @customer;');
    expect([...parsed.sources].sort()).toEqual(['[dbo].[orders]', '[dbo].[rate]']);
    expect(parsed.targets).toEqual([]);
  });
  it('retains ordinary view scalar/TVF and cross-database calls', () => {
    const parsed = parseSqlBody('CREATE VIEW dbo.Report AS SELECT dbo.Rate(r.Amount), OtherDb.dbo.RemoteRate(r.Amount) FROM dbo.Rows(1) r;');
    expect([...parsed.sources].sort()).toEqual(['[dbo].[rate]', '[dbo].[rows]']);
    expect(parsed.crossDbSources).toEqual(['otherdb.dbo.remoterate']);
  });
  it('preserves checked-CS call identities while excluding the declaration', () => {
    const parsed = parseSqlBody('CREATE FUNCTION dbo.Rate(@amount int) RETURNS int AS BEGIN RETURN dbo.rate(@amount); END;', undefined, true);
    expect(parsed.sources).toEqual(['[dbo].[rate]']);
  });
});
