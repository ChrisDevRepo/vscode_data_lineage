-- MERGE Pattern 03: MERGE with CTE as source (CTE name must NOT be extracted)
-- EXPECT  sources:[dbo].[ProductInventory],[dbo].[SalesOrderDetail]  targets:[dbo].[ProductSummary]  absent:[dbo].[InventoryCTE],[dbo].[SalesCTE],[dbo].[CombinedCTE]

WITH InventoryCTE AS (
    SELECT
        pi.[ProductID],
        SUM(pi.[Quantity])         AS TotalQty,
        AVG(pi.[LocationID]  * 1.0) AS AvgLocation,
        MIN(pi.[ModifiedDate])     AS OldestRecord
    FROM [dbo].[ProductInventory] pi
    GROUP BY pi.[ProductID]
),
SalesCTE AS (
    SELECT
        sod.[ProductID],
        SUM(sod.[OrderQty])         AS TotalOrdered,
        SUM(sod.[LineTotal])        AS TotalRevenue,
        COUNT(DISTINCT sod.[SalesOrderID]) AS OrderCount
    FROM [dbo].[SalesOrderDetail] sod
    WHERE sod.[ModifiedDate] >= DATEADD(MONTH, -3, GETUTCDATE())
    GROUP BY sod.[ProductID]
),
CombinedCTE AS (
    SELECT
        ISNULL(i.[ProductID], s.[ProductID]) AS [ProductID],
        ISNULL(i.[TotalQty], 0)              AS [TotalQty],
        ISNULL(s.[TotalOrdered], 0)          AS [TotalOrdered],
        ISNULL(s.[TotalRevenue], 0.0)        AS [TotalRevenue],
        ISNULL(s.[OrderCount], 0)            AS [OrderCount]
    FROM       InventoryCTE AS i
    FULL JOIN  SalesCTE      AS s ON i.[ProductID] = s.[ProductID]
)
MERGE INTO [dbo].[ProductSummary] AS tgt
USING CombinedCTE AS src ON tgt.[ProductID] = src.[ProductID]
WHEN MATCHED THEN
    UPDATE SET
        tgt.[TotalInventory]  = src.[TotalQty],
        tgt.[TotalOrdered]    = src.[TotalOrdered],
        tgt.[TotalRevenue]    = src.[TotalRevenue],
        tgt.[OrderCount]      = src.[OrderCount],
        tgt.[LastRefreshed]   = GETUTCDATE()
WHEN NOT MATCHED BY TARGET THEN
    INSERT ([ProductID],[TotalInventory],[TotalOrdered],[TotalRevenue],[OrderCount],[LastRefreshed])
    VALUES (src.[ProductID],src.[TotalQty],src.[TotalOrdered],src.[TotalRevenue],src.[OrderCount],GETUTCDATE())
WHEN NOT MATCHED BY SOURCE THEN
    UPDATE SET tgt.[IsActive] = 0;
