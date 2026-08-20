-- CROSS/OUTER APPLY Pattern 01: CROSS APPLY with schema-qualified TVF
-- EXPECT  sources:[dbo].[Order],[dbo].[udf_GetOrderLines]  targets:[dbo].[OrderLineSummary]  exec:

INSERT INTO [dbo].[OrderLineSummary] (
    [OrderID],
    [ProductID],
    [ProductName],
    [Quantity],
    [UnitPrice],
    [LineTotal],
    [Margin],
    [SummarizedAt]
)
SELECT
    o.[OrderID],
    ol.[ProductID],
    ol.[ProductName],
    ol.[Quantity],
    ol.[UnitPrice],
    ol.[Quantity] * ol.[UnitPrice] AS LineTotal,
    (ol.[UnitPrice] - ol.[StandardCost]) * ol.[Quantity] AS Margin,
    GETUTCDATE()
FROM [dbo].[Order] AS o
CROSS APPLY [dbo].[udf_GetOrderLines](o.[OrderID], o.[CurrencyCode]) AS ol
WHERE o.[Status] = N'COMPLETE'
  AND o.[OrderDate] >= DATEADD(DAY,-7,GETDATE());
