-- NESTED SUBQUERY Pattern 01: Deep nested subqueries — all referenced base tables captured
-- EXPECT  sources:[dbo].[SalesOrder],[dbo].[Customer],[dbo].[Territory],[dbo].[SalesQuota],[sales].[SalesPerson]  targets:[dbo].[SalesRanking]  exec:

INSERT INTO [dbo].[SalesRanking] (
    [RankDate],
    [SalesPersonID],
    [SalesPersonName],
    [TerritoryName],
    [YTDAmount],
    [QuotaAmount],
    [QuotaAttainment],
    [Rank],
    [Percentile]
)
SELECT
    CAST(GETDATE() AS DATE),
    sp_ranked.[SalesPersonID],
    sp_ranked.[SalesPersonName],
    sp_ranked.[TerritoryName],
    sp_ranked.[YTDAmount],
    sp_ranked.[QuotaAmount],
    sp_ranked.[YTDAmount] / NULLIF(sp_ranked.[QuotaAmount],0) * 100,
    RANK() OVER (ORDER BY sp_ranked.[YTDAmount] DESC),
    PERCENT_RANK() OVER (ORDER BY sp_ranked.[YTDAmount])
FROM (
    -- Level 2: Join sales aggregates with quota
    SELECT
        agg.[SalesPersonID],
        agg.[SalesPersonName],
        agg.[TerritoryName],
        agg.[YTDAmount],
        ISNULL(q.[QuotaAmount], 0) AS QuotaAmount
    FROM (
        -- Level 3: Aggregate orders by salesperson
        SELECT
            sp.[BusinessEntityID]              AS SalesPersonID,
            sp.[FirstName] + N' ' + sp.[LastName] AS SalesPersonName,
            t.[Name]                           AS TerritoryName,
            ISNULL(SUM(so.[TotalDue]), 0)      AS YTDAmount
        FROM      [sales].[SalesPerson]  AS sp
        LEFT JOIN [dbo].[Territory]      AS t  ON t.[TerritoryID]       = sp.[TerritoryID]
        LEFT JOIN (
            -- Level 4: Filter orders for current year only
            SELECT [SalesPersonID], [TotalDue]
            FROM   [dbo].[SalesOrder]
            WHERE  YEAR([OrderDate]) = YEAR(GETDATE())
              AND  [Status] = 5   -- Shipped
        ) AS so ON so.[SalesPersonID] = sp.[BusinessEntityID]
        LEFT JOIN [dbo].[Customer] AS c ON c.[TerritoryID] = t.[TerritoryID]
        GROUP BY sp.[BusinessEntityID], sp.[FirstName], sp.[LastName], t.[Name]
    ) AS agg
    LEFT JOIN (
        -- Level 3b: Get annual quota
        SELECT [SalesPersonID], SUM([SalesQuota]) AS QuotaAmount
        FROM   [dbo].[SalesQuota]
        WHERE  YEAR([QuotaDate]) = YEAR(GETDATE())
        GROUP BY [SalesPersonID]
    ) AS q ON q.[SalesPersonID] = agg.[SalesPersonID]
) AS sp_ranked;
