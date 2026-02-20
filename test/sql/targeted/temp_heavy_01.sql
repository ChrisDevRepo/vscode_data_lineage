-- TEMP TABLE HEAVY Pattern 01: Many #tempTables — none should appear in extracted deps
-- EXPECT  sources:[dbo].[SalesOrder],[dbo].[SalesOrderLine],[dbo].[Product],[dbo].[Customer],[ref].[Region],[dbo].[ProductCategory]  targets:[reporting].[MonthlySalesCube]  exec:
-- #temp tables: #RawOrders, #AggByProduct, #AggByCustomer, #Regional — must NOT be captured

-- Stage 1: Pull raw data into temp
CREATE TABLE #RawOrders (
    [OrderID]     INT,
    [CustomerID]  INT,
    [ProductID]   INT,
    [OrderDate]   DATE,
    [Quantity]    INT,
    [UnitPrice]   DECIMAL(18,4),
    [LineTotal]   DECIMAL(18,4),
    [RegionCode]  NVARCHAR(10)
);

INSERT INTO #RawOrders
SELECT
    sol.[SalesOrderID],
    soh.[CustomerID],
    sol.[ProductID],
    CAST(soh.[OrderDate] AS DATE),
    sol.[OrderQty],
    sol.[UnitPrice],
    sol.[LineTotal],
    r.[RegionCode]
FROM [dbo].[SalesOrder]      AS soh
JOIN [dbo].[SalesOrderLine]  AS sol ON sol.[SalesOrderID] = soh.[SalesOrderID]
JOIN [dbo].[Customer]        AS c   ON c.[CustomerID]     = soh.[CustomerID]
JOIN [ref].[Region]          AS r   ON r.[RegionID]       = c.[RegionID]
WHERE MONTH(soh.[OrderDate]) = MONTH(GETDATE())
  AND YEAR(soh.[OrderDate])  = YEAR(GETDATE());

-- Stage 2: Aggregate by product
CREATE TABLE #AggByProduct (
    [ProductID]    INT,
    [CategoryID]   INT,
    [CategoryName] NVARCHAR(100),
    [TotalQty]     INT,
    [TotalRevenue] DECIMAL(18,2)
);

INSERT INTO #AggByProduct
SELECT
    r.[ProductID],
    pc.[ProductCategoryID],
    pc.[Name],
    SUM(r.[Quantity]),
    SUM(r.[LineTotal])
FROM #RawOrders             AS r
JOIN [dbo].[Product]        AS p  ON p.[ProductID]        = r.[ProductID]
JOIN [dbo].[ProductCategory] AS pc ON pc.[ProductCategoryID] = p.[ProductCategoryID]
GROUP BY r.[ProductID], pc.[ProductCategoryID], pc.[Name];

-- Stage 3: Aggregate by customer
CREATE TABLE #AggByCustomer (
    [CustomerID]   INT,
    [RegionCode]   NVARCHAR(10),
    [OrderCount]   INT,
    [TotalRevenue] DECIMAL(18,2)
);

INSERT INTO #AggByCustomer
SELECT [CustomerID], [RegionCode], COUNT(DISTINCT [OrderID]), SUM([LineTotal])
FROM   #RawOrders
GROUP BY [CustomerID], [RegionCode];

-- Stage 4: Regional rollup
CREATE TABLE #Regional (
    [RegionCode]   NVARCHAR(10),
    [OrderCount]   INT,
    [TotalRevenue] DECIMAL(18,2),
    [AvgOrderValue] DECIMAL(18,2)
);

INSERT INTO #Regional
SELECT [RegionCode], COUNT(*), SUM([TotalRevenue]), AVG([TotalRevenue])
FROM   #AggByCustomer
GROUP BY [RegionCode];

-- Final: Load cube from temp data
INSERT INTO [reporting].[MonthlySalesCube] (
    [ReportMonth],[ReportYear],[ProductID],[CategoryID],[CategoryName],
    [CustomerID],[RegionCode],[OrderCount],[TotalQty],[TotalRevenue],[LoadedAt]
)
SELECT
    MONTH(GETDATE()),
    YEAR(GETDATE()),
    p.[ProductID],
    p.[CategoryID],
    p.[CategoryName],
    c.[CustomerID],
    c.[RegionCode],
    1,
    SUM(r.[Quantity]),
    SUM(r.[LineTotal]),
    GETUTCDATE()
FROM #RawOrders      AS r
JOIN #AggByProduct   AS p ON p.[ProductID]  = r.[ProductID]
JOIN #AggByCustomer  AS c ON c.[CustomerID] = r.[CustomerID]
GROUP BY MONTH(GETDATE()),YEAR(GETDATE()),p.[ProductID],p.[CategoryID],p.[CategoryName],c.[CustomerID],c.[RegionCode];

DROP TABLE #RawOrders, #AggByProduct, #AggByCustomer, #Regional;
