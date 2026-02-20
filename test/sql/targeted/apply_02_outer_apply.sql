-- CROSS/OUTER APPLY Pattern 02: OUTER APPLY — preserves rows with no TVF match
-- EXPECT  sources:[dbo].[Customer],[sales].[udf_GetLastOrder]  targets:[dbo].[CustomerActivity]  exec:

INSERT INTO [dbo].[CustomerActivity] (
    [CustomerID],
    [CustomerName],
    [LastOrderID],
    [LastOrderDate],
    [LastOrderAmount],
    [DaysSinceOrder],
    [RefreshedAt]
)
SELECT
    c.[CustomerID],
    c.[FullName],
    lo.[OrderID],
    lo.[OrderDate],
    lo.[TotalAmount],
    DATEDIFF(DAY, lo.[OrderDate], GETDATE()),
    GETUTCDATE()
FROM [dbo].[Customer] AS c
OUTER APPLY [sales].[udf_GetLastOrder](c.[CustomerID]) AS lo
WHERE c.[IsActive] = 1;
