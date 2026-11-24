/**
 * The scope bundle estimates a definition's tokens with the bundled o200k counter, the one the
 * turn's token budget runs on: `estimated_ddl_tokens` and the fit decision against
 * `ai.discoveryTokenBudget` follow the real token count of the SQL, not a characters-per-token
 * guess.
 */
import { Tiktoken } from 'js-tiktoken/lite';
import o200kBase from 'js-tiktoken/ranks/o200k_base';
import { describe, expect, it } from 'vitest';
import { getNodeDdl } from '../../../src/ai/support/graphUtils';
import { createTurnTokenBudget } from '../../../src/ai/support/tokenBudget';
import { getScopeBundle, searchDdl } from '../../../src/ai/tools/tools';
import { countTokens } from '../../../src/ai/support/tokenCount';
import { REJECTION_CODES } from '../../../src/ai/support/rejectionCodes';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';

const BILL_OF_MATERIALS = `CREATE PROCEDURE [dbo].[uspGetBillOfMaterials]
    @StartProductID [int],
    @CheckDate [datetime]
AS
BEGIN
    SET NOCOUNT ON;

    -- Use recursive query to generate a multi-level Bill of Material (i.e. all level 1
    -- components of a level 0 assembly, all level 2 components of a level 1 assembly)
    -- The CheckDate eliminates any components that are no longer used in the product on this date.
    WITH [BOM_cte]([ProductAssemblyID], [ComponentID], [ComponentDesc], [PerAssemblyQty], [StandardCost], [ListPrice], [BOMLevel], [RecursionLevel]) -- CTE name and columns
    AS (
        SELECT b.[ProductAssemblyID], b.[ComponentID], p.[Name], b.[PerAssemblyQty], p.[StandardCost], p.[ListPrice], b.[BOMLevel], 0 -- Get the initial list of components for the bike assembly
        FROM [Production].[BillOfMaterials] b
            INNER JOIN [Production].[Product] p
            ON b.[ComponentID] = p.[ProductID]
        WHERE b.[ProductAssemblyID] = @StartProductID
            AND @CheckDate >= b.[StartDate]
            AND @CheckDate <= ISNULL(b.[EndDate], @CheckDate)
        UNION ALL
        SELECT b.[ProductAssemblyID], b.[ComponentID], p.[Name], b.[PerAssemblyQty], p.[StandardCost], p.[ListPrice], b.[BOMLevel], [RecursionLevel] + 1 -- Join recursive member to anchor
        FROM [BOM_cte] cte
            INNER JOIN [Production].[BillOfMaterials] b
            ON b.[ProductAssemblyID] = cte.[ComponentID]
            INNER JOIN [Production].[Product] p
            ON b.[ComponentID] = p.[ProductID]
        WHERE @CheckDate >= b.[StartDate]
            AND @CheckDate <= ISNULL(b.[EndDate], @CheckDate)
        )
    -- Outer select from the CTE
    SELECT b.[ProductAssemblyID], b.[ComponentID], b.[ComponentDesc], SUM(b.[PerAssemblyQty]) AS [TotalQuantity], b.[StandardCost], b.[ListPrice], b.[BOMLevel], b.[RecursionLevel]
    FROM [BOM_cte] b
    GROUP BY b.[ComponentID], b.[ComponentDesc], b.[ProductAssemblyID], b.[BOMLevel], b.[RecursionLevel], b.[StandardCost], b.[ListPrice]
    ORDER BY b.[BOMLevel], b.[ProductAssemblyID], b.[ComponentID]
    OPTION (MAXRECURSION 25)
END;`;

/** A procedure holding eight copies of a real definition, as one dense body. */
const BODY = Array.from({ length: 8 }, (_, i) => BILL_OF_MATERIALS.replace('uspGetBillOfMaterials', `uspGetBillOfMaterials${i}`)).join('\nGO\n');

const origin = makeNode({ id: '[dbo].[uspBom]', schema: 'dbo', name: 'uspBom', type: 'procedure', bodyScript: BODY });
const model = makeModel([origin], [], ['dbo']);
const graph = makeGraph([origin], []);
const nodeMap = new Map([[origin.id, origin]]);

/** The o200k token count of the definition the bundle measures. */
const o200kTokens = new Tiktoken(o200kBase).encode(getNodeDdl(origin.id, nodeMap)!).length;
const bundle = (budget: ReturnType<typeof createTurnTokenBudget>) =>
  getScopeBundle(model, graph, { origin: origin.id, direction: 'downstream', depth: 1 }, budget) as {
    include_ddl: boolean;
    ddl_withheld?: string;
    scope: { estimated_ddl_chars: number; estimated_ddl_tokens: number };
  };

describe('scope bundle DDL token estimate', () => {
  it('counts the definition with the o200k counter, within the counter\'s safety margin', () => {
    const { scope } = bundle(createTurnTokenBudget({ discoveryTokenBudget: 100_000 }));
    expect(Math.ceil(scope.estimated_ddl_chars / 4), 'the chars/4 guess is below the real count').toBeLessThan(o200kTokens);
    expect(scope.estimated_ddl_tokens).toBeGreaterThanOrEqual(o200kTokens);
    expect(scope.estimated_ddl_tokens).toBeLessThanOrEqual(Math.ceil(o200kTokens * 1.2));
  });

  it('withholds a definition whose real token count exceeds the budget although chars/4 fits it', () => {
    const { scope, ...reply } = bundle(createTurnTokenBudget({ discoveryTokenBudget: o200kTokens - 1 }));
    expect(Math.ceil(scope.estimated_ddl_chars / 4)).toBeLessThanOrEqual(o200kTokens - 1);
    expect(reply).toMatchObject({ include_ddl: false, ddl_withheld: 'over_budget' });
  });
});

describe('search_ddl result admission', () => {
  it('refuses a reply whose real token count exceeds the budget although chars/4 fits it', async () => {
    const whole = await searchDdl(model, new Set(), 'Production', null);
    const reply = JSON.stringify(whole);
    const budget = countTokens(reply) - 1;
    expect(budget, 'above the budget floor').toBeGreaterThan(1000);
    expect(Math.ceil(reply.length / 4), 'the chars/4 guess fits').toBeLessThanOrEqual(budget);
    const refused = await searchDdl(model, new Set(), 'Production', createTurnTokenBudget({ discoveryTokenBudget: budget }));
    expect(refused).toMatchObject({ code: REJECTION_CODES.overDiscoveryBudget });
  });
});
