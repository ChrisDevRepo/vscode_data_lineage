/** A module without a readable definition is loaded without edges and marked; the catalog cannot give the direction. */
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
