/** A module without a readable definition is loaded without edges and marked; the catalog cannot give the direction. A module with a construct that is not fully supported keeps what the parser captures and is recorded for a warning. */
import { beforeAll, describe, expect, it } from 'vitest';
import { buildModel } from '../../../src/engine/modelBuilder';
import { loadParseRules } from '../helpers/testUtils';

beforeAll(() => { loadParseRules(); });
type BuildObject = Parameters<typeof buildModel>[0][number];

describe('module with an unreadable definition', () => {
  const table: BuildObject = { fullName: '[dbo].[Orders]', type: 'table' };
  const deps = (name: string) => [{ sourceName: name, targetName: '[dbo].[Orders]' }];

  it.each(['view', 'function'] as const)('%s without body keeps its catalog edge, whose direction is always read', type => {
    const name = '[dbo].[Hidden]';
    const objects: BuildObject[] = [{ fullName: name, type }, table];
    const model = buildModel(objects, deps(name), objects);
    expect(model.edges.map(e => [e.source, e.target])).toEqual([['[dbo].[orders]', '[dbo].[hidden]']]);
    expect(model.nodes.some(n => n.definitionUnreadable)).toBe(false);
  });

  it('procedure without body has no edges and is flagged', () => {
    const name = '[dbo].[Hidden]';
    const objects: BuildObject[] = [{ fullName: name, type: 'procedure' }, table];
    const model = buildModel(objects, deps(name), objects);
    expect(model.edges).toEqual([]);
    expect(model.nodes.find(n => n.id === '[dbo].[hidden]')?.definitionUnreadable).toBe(true);
    expect(model.nodes.find(n => n.id === '[dbo].[orders]')?.definitionUnreadable).toBeUndefined();
    expect(model.parseStats?.unreadableDefinitions).toEqual([name]);
  });

  it('keeps the edges of a procedure with a readable body and flags nothing', () => {
    const name = '[dbo].[Visible]';
    const objects: BuildObject[] = [{ fullName: name, type: 'procedure', bodyScript: 'INSERT INTO [dbo].[Orders] SELECT 1;' }, table];
    const model = buildModel(objects, deps(name), objects);
    expect(model.edges.map(e => [e.source, e.target])).toEqual([['[dbo].[visible]', '[dbo].[orders]']]);
    expect(model.nodes.some(n => n.definitionUnreadable)).toBe(false);
    expect(model.parseStats?.unreadableDefinitions).toBeUndefined();
  });
});

describe('module with a construct that is not fully supported', () => {
  const name = '[dbo].[Load]';
  const build = (bodyScript: string) => {
    const objects: BuildObject[] = [{ fullName: name, type: 'procedure', bodyScript }, { fullName: '[dbo].[Orders]', type: 'table' }];
    return buildModel(objects, [], objects);
  };

  it.each([
    ['Cursor', 'DECLARE c CURSOR LOCAL FOR SELECT a FROM [dbo].[Orders]; OPEN c; FETCH NEXT FROM c INTO @a;'],
    ['Dynamic SQL', "EXEC('SELECT 1'); SELECT a FROM [dbo].[Orders];"],
    ['Dynamic SQL', "EXEC [sys].[sp_executesql] N'SELECT 1'; SELECT a FROM [dbo].[Orders];"],
  ])('records a %s and keeps the captured read: %s', (label, body) => {
    const model = build(body);
    expect(model.edges.map(e => [e.source, e.target])).toEqual([['[dbo].[orders]', '[dbo].[load]']]);
    expect(model.parseStats?.unsupported).toEqual({ [label]: [name] });
  });

  it.each([
    "-- DECLARE c CURSOR FOR\nSELECT 'CURSOR', 'EXEC(@x)' AS a FROM [dbo].[Orders];",
    'DECLARE @cursor INT; SELECT [cursor] FROM [dbo].[Orders];',
    "SELECT CURSOR_STATUS('local', 'c') FROM [dbo].[Orders]; EXEC dbo.uspAudit;",
  ])('records nothing for a comment, string, identifier or plain call: %s', body => {
    expect(build(body).parseStats?.unsupported).toBeUndefined();
  });
});
