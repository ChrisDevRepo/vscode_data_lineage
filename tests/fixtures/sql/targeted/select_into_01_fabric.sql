-- SELECT INTO Pattern 01: SELECT ... INTO (creates new table from SELECT, Fabric/Synapse pattern)
-- EXPECT  sources:[dbo].[SalesOrderHeader],[dbo].[SalesOrderDetail],[dbo].[Product]  targets:[dbo].[SalesSnapshot]  exec:

-- Fabric/Synapse: SELECT INTO creates target table
SELECT
    soh.[SalesOrderID],
    soh.[OrderDate],
    soh.[CustomerID],
    soh.[TerritoryID],
    soh.[TotalDue],
    soh.[Status],
    sod.[ProductID],
    p.[Name]          AS [ProductName],
    p.[ProductNumber],
    sod.[OrderQty],
    sod.[UnitPrice],
    sod.[LineTotal]
INTO [dbo].[SalesSnapshot]
FROM [dbo].[SalesOrderHeader] AS soh
JOIN [dbo].[SalesOrderDetail] AS sod ON sod.[SalesOrderID] = soh.[SalesOrderID]
JOIN [dbo].[Product]          AS p   ON p.[ProductID]      = sod.[ProductID]
WHERE soh.[OrderDate] >= DATEADD(MONTH,-1,GETDATE())
  AND soh.[Status] IN (5,6);    -- shipped or cancelled
