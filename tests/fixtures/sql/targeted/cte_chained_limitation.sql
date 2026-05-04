-- CTE CHAIN RESOLUTION: WITH c1 AS (...FROM t1), c2 AS (...FROM c1) UPDATE c2 SET ...
-- Pass 1.6 now resolves CTE chains: c2's first FROM is c1 (unqualified), which is looked
-- up in the cteMap. Chain resolution collapses c2 → c1 → [dbo].[SalesOrder].
-- Paren-balanced body detection finds exact CTE boundaries (no magic-number window).
--
-- Previously a by-design limitation; resolved after 10 real-world SPs hit this pattern
-- (UPDATE alias SET ... FROM cte_chain over chained CTEs).
--
-- EXPECT  sources:[dbo].[SalesOrder]  targets:[dbo].[SalesOrder]

WITH BaseOrders AS (
    SELECT
        o.[OrderID],
        o.[CustomerID],
        o.[TotalAmount],
        o.[Status]
    FROM [dbo].[SalesOrder] AS o
    WHERE o.[Status] = N'PENDING'
),
OrdersWithLimit AS (
    SELECT
        b.[OrderID],
        b.[TotalAmount]
    FROM BaseOrders AS b          -- references CTE, not a real table
    WHERE b.[TotalAmount] > 100
)
UPDATE OrdersWithLimit            -- alias of alias: chain not resolved
SET    [Status] = N'APPROVED'
WHERE  [TotalAmount] BETWEEN 100 AND 10000;

-- Expected parser behavior (after chain resolution):
--   sources: [dbo].[SalesOrder]       (BaseOrders CTE resolved by Pass 1.6 via its FROM)
--   targets: [dbo].[SalesOrder]       (OrdersWithLimit → BaseOrders → [dbo].[SalesOrder] chain resolved)
