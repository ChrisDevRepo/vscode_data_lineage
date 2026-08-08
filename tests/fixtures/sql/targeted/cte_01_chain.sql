-- CTE Pattern 01: Multi-CTE chain — only base tables captured, CTE names excluded
-- EXPECT  sources:[dbo].[SalesOrder],[dbo].[SalesOrderLine],[dbo].[Product],[dbo].[Customer],[ref].[Territory]  targets:[dbo].[SalesPerformance]  absent:[OrderBaseCTE],[LineSumCTE],[ProductCTE],[CustomerCTE],[FinalCTE]

WITH OrderBaseCTE AS (
    SELECT
        so.[SalesOrderID],
        so.[OrderDate],
        so.[CustomerID],
        so.[TerritoryID],
        so.[Status],
        so.[ShipDate]
    FROM [dbo].[SalesOrder] AS so
    WHERE so.[OrderDate] >= DATEADD(MONTH,-3,GETDATE())
      AND so.[Status] NOT IN (N'CANCELLED',N'DRAFT')
),
LineSumCTE AS (
    SELECT
        sol.[SalesOrderID],
        SUM(sol.[LineTotal])      AS OrderTotal,
        SUM(sol.[TaxAmount])      AS TaxTotal,
        SUM(sol.[DiscountAmount]) AS DiscountTotal,
        COUNT(1)                  AS LineCount,
        SUM(sol.[Quantity])       AS TotalQty
    FROM [dbo].[SalesOrderLine] AS sol
    JOIN OrderBaseCTE            AS ob ON ob.[SalesOrderID] = sol.[SalesOrderID]
    GROUP BY sol.[SalesOrderID]
),
ProductCTE AS (
    SELECT DISTINCT
        sol.[SalesOrderID],
        p.[ProductCategoryID],
        p.[ProductSubCategoryID]
    FROM [dbo].[SalesOrderLine] AS sol
    JOIN [dbo].[Product]        AS p  ON p.[ProductID] = sol.[ProductID]
    JOIN OrderBaseCTE           AS ob ON ob.[SalesOrderID] = sol.[SalesOrderID]
),
CustomerCTE AS (
    SELECT
        c.[CustomerID],
        c.[AccountNumber],
        c.[TerritoryID]   AS CustomerTerritory,
        t.[Name]          AS TerritoryName
    FROM [dbo].[Customer]   AS c
    JOIN [ref].[Territory]  AS t ON t.[TerritoryID] = c.[TerritoryID]
),
FinalCTE AS (
    SELECT
        ob.[SalesOrderID],
        ob.[OrderDate],
        ob.[CustomerID],
        cc.[AccountNumber],
        cc.[TerritoryName],
        ls.[OrderTotal],
        ls.[TaxTotal],
        ls.[DiscountTotal],
        ls.[LineCount],
        ls.[TotalQty],
        pc.[ProductCategoryID],
        pc.[ProductSubCategoryID]
    FROM  OrderBaseCTE AS ob
    JOIN  LineSumCTE   AS ls ON ls.[SalesOrderID] = ob.[SalesOrderID]
    JOIN  ProductCTE   AS pc ON pc.[SalesOrderID] = ob.[SalesOrderID]
    JOIN  CustomerCTE  AS cc ON cc.[CustomerID]   = ob.[CustomerID]
)
INSERT INTO [dbo].[SalesPerformance] (
    [SalesOrderID],[OrderDate],[CustomerID],[AccountNumber],[TerritoryName],
    [OrderTotal],[TaxTotal],[DiscountTotal],[LineCount],[TotalQty],
    [ProductCategoryID],[ProductSubCategoryID],[LoadedAt]
)
SELECT *, GETUTCDATE() FROM FinalCTE;
