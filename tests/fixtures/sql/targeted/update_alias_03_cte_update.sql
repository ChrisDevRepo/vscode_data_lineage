-- UPDATE ALIAS Pattern 03: UPDATE via CTE (CTE names must NOT be captured as targets)
-- EXPECT  sources:[dbo].[Inventory],[dbo].[SalesOrderLine]  targets:[dbo].[Inventory]
-- mustNotContain: InventoryWithSales (CTE name, no schema dot)
-- The CTE joins one base table to a GROUP BY derived table, which cannot be written through, so
-- the write lands on the base table; the CTE name itself is never a target.

WITH InventoryWithSales AS (
    SELECT
        inv.[ProductID],
        inv.[LocationID],
        inv.[QtyOnHand],
        inv.[ReorderLevel],
        inv.[LastUpdated],
        ISNULL(sold.[QtySold30d], 0) AS QtySold30d
    FROM [dbo].[Inventory] AS inv
    LEFT JOIN (
        SELECT [ProductID], SUM([Quantity]) AS QtySold30d
        FROM   [dbo].[SalesOrderLine]
        WHERE  [OrderDate] >= DATEADD(DAY,-30,GETDATE())
          AND  [Status] = N'SHIPPED'
        GROUP BY [ProductID]
    ) AS sold ON sold.[ProductID] = inv.[ProductID]
)
UPDATE InventoryWithSales
SET    [QtyOnHand]   = [QtyOnHand] - [QtySold30d],
       [LastUpdated] = GETUTCDATE()
WHERE  [QtyOnHand]   > 0
  AND  [QtySold30d]  > 0;
