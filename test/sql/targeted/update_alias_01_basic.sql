-- UPDATE ALIAS Pattern 01: UPDATE alias SET ... FROM schema.table alias — regression guard for e7214ee fix
-- EXPECT  sources:[dbo].[Customer]  targets:[dbo].[Customer]
-- This SP is a bidirectional pattern: Customer is both read (JOIN) and written (UPDATE)

UPDATE c
SET
    c.[TotalOrders]    = agg.[OrderCount],
    c.[TotalSpend]     = agg.[TotalAmount],
    c.[LastOrderDate]  = agg.[MaxOrderDate],
    c.[CustomerTier]   = CASE
                            WHEN agg.[TotalAmount] >= 50000 THEN N'PLATINUM'
                            WHEN agg.[TotalAmount] >= 10000 THEN N'GOLD'
                            WHEN agg.[TotalAmount] >= 1000  THEN N'SILVER'
                            ELSE N'BRONZE'
                         END,
    c.[ModifiedDate]   = GETUTCDATE()
FROM [dbo].[Customer] AS c
JOIN (
    SELECT
        o.[CustomerID],
        COUNT(o.[OrderID])       AS OrderCount,
        SUM(o.[TotalAmount])     AS TotalAmount,
        MAX(o.[OrderDate])       AS MaxOrderDate
    FROM [dbo].[Customer] AS cInner
    JOIN [dbo].[Order]    AS o ON o.[CustomerID] = cInner.[CustomerID]
    WHERE o.[Status] = N'COMPLETE'
    GROUP BY o.[CustomerID]
) AS agg ON agg.[CustomerID] = c.[CustomerID];
