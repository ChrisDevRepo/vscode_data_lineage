/**
 * SQL-body dependency extraction completes every match before binding against the loaded catalog.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { buildModel } from '../../../src/engine/modelBuilder';
import { loadParseRules } from '../helpers/testUtils';

beforeAll(() => { loadParseRules(); });

type BuildObject = Parameters<typeof buildModel>[0][number];

describe('complete model-body dependencies', () => {
  it.each([false, true])('binds the last catalog reference after more than ten thousand matches under CS=%s', (cs) => {
    const body = Array.from({ length: 10_001 }, (_, i) => `SELECT * FROM [dbo].[T${i}]`).join('\n');
    const objects: BuildObject[] = [{ fullName: '[dbo].[spHuge]', type: 'procedure', bodyScript: body }, { fullName: '[dbo].[T10000]', type: 'table' }];
    const model = buildModel(objects, [], objects, undefined, false, undefined, cs);
    expect(model.edges.map(edge => [edge.source, edge.target])).toEqual([[cs ? '[dbo].[T10000]' : '[dbo].[t10000]', cs ? '[dbo].[spHuge]' : '[dbo].[sphuge]']]);
    expect(model.parseStats?.parsedRefs).toBe(10_001);
    expect(model.parseStats?.droppedRefs).toHaveLength(10_000);
    expect(model.warnings).toBeUndefined();
  });
});
