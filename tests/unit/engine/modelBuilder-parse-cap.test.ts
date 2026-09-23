/**
 * Pins the parser match cap: a body that exceeds it is reported in parse stats and model warnings,
 * and an ordinary model carries neither.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { buildModel } from '../../../src/engine/modelBuilder';
import { loadParseRules } from '../helpers/testUtils';

beforeAll(() => { loadParseRules(); });

type BuildObject = Parameters<typeof buildModel>[0][number];

describe('parser match cap', () => {
  it('reports a capped body in parse stats and the model warnings; an ordinary model carries neither', () => {
    const body = Array.from({ length: 10_001 }, (_, i) => `SELECT * FROM [dbo].[T${i}]`).join('\n');
    const capped = buildModel([{ fullName: '[dbo].[spHuge]', type: 'procedure', bodyScript: body } as BuildObject], []);
    expect(capped.parseStats?.cappedRules?.[0]).toMatch(/^dbo\.spHuge: /);
    expect(capped.warnings?.some(w => w.includes('match limit'))).toBe(true);

    const plain = buildModel([{ fullName: '[dbo].[spSmall]', type: 'procedure', bodyScript: 'SELECT * FROM [dbo].[T1]' } as BuildObject], []);
    expect(plain.parseStats?.cappedRules).toBeUndefined();
    expect(plain.warnings).toBeUndefined();
  });
});
