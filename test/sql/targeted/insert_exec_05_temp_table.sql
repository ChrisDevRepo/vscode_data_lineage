-- INSERT EXEC Pattern 05: INSERT INTO temp table via EXEC — temp table must NOT be captured
-- EXPECT  sources:[dbo].[Order],[dbo].[OrderLine]  targets:[dbo].[OrderSummary]  exec:[dbo].[usp_GetOpenOrders]  absent:[#TempOrders]

-- Populate temp table from SP
CREATE TABLE #TempOrders (
    [OrderID]       INT,
    [CustomerID]    INT,
    [OrderDate]     DATE,
    [TotalAmount]   DECIMAL(18,2),
    [LineCount]     INT,
    [Status]        NVARCHAR(20)
);

INSERT INTO #TempOrders ([OrderID],[CustomerID],[OrderDate],[TotalAmount],[LineCount],[Status])
EXEC [dbo].[usp_GetOpenOrders] @DaysBack = 30;

-- Join temp table with catalog tables and persist result
INSERT INTO [dbo].[OrderSummary] ([OrderID],[CustomerID],[OrderDate],[TotalAmount],[LineCount],[Status],[CreatedDate])
SELECT
    t.[OrderID],
    t.[CustomerID],
    t.[OrderDate],
    t.[TotalAmount],
    t.[LineCount],
    t.[Status],
    GETUTCDATE()
FROM #TempOrders AS t
JOIN [dbo].[Order]     AS o  ON o.[OrderID] = t.[OrderID]
JOIN [dbo].[OrderLine] AS ol ON ol.[OrderID] = t.[OrderID]
WHERE ol.[Status] <> N'Cancelled'
  AND o.[IsArchived] = 0;

DROP TABLE #TempOrders;
