-- UPDATE ALIAS Pattern 03: UPDATE via CTE (CTE names must NOT be captured as targets)
-- EXPECT  sources:[dbo].[Inventory],[dbo].[SalesOrderLine]  targets:[dbo].[Inventory]
-- mustNotContain: InventoryWithSales (CTE name, no schema dot)
-- CTE-based UPDATE: the update target is the underlying table, not the CTE name

WITH InventoryWithSales AS (
    SELECT
        inv.[ProductID],
        inv.[LocationID],
        inv.[QtyOnHand],
        inv.[ReorderLevel],
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
