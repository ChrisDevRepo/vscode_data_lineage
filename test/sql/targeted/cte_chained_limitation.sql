-- CTE CHAIN LIMITATION: WITH c1 AS (...FROM t1), c2 AS (...FROM c1) UPDATE c2 SET ...
-- When a CTE references another CTE (not a real table), Pass 1.6 cannot resolve the
-- chain: c2's first FROM is c1 (no schema dot), so fromMatch returns null and c2 remains
-- unresolved. The UPDATE c2 is not translated to any real table.
--
-- By-design limitation: zero occurrences in 448 SPs checked (196 real-world + 252 customer).
-- Adding two-pass chain resolution (~15 TS lines) is not justified by current frequency.
--
-- STABILITY: no oracle (no -- EXPECT line) — parser must not crash, output must be bounded.

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

-- Expected parser behavior:
--   sources: [dbo].[SalesOrder]       (BaseOrders CTE resolved by Pass 1.6 via its FROM)
--   targets: (none)                   (OrdersWithLimit not resolved — FROM is BaseOrders, no dot)
-- This is the known gap. A two-pass resolver would add [dbo].[SalesOrder] to targets.
