-- COMMENTS Pattern 01: Massive block comments containing SQL-like content — must NOT be extracted
-- EXPECT  sources:[dbo].[Customer],[dbo].[Order]  targets:[dbo].[CustomerOrderSummary]  absent:[dbo].[OldCustomer],[dbo].[LegacyOrder],[dbo].[DeprecatedSummary]

/*
=============================================================================
PROCEDURE: usp_RefreshCustomerOrderSummary
AUTHOR:    Data Engineering Team
DATE:      2019-03-14
VERSION:   4.2.1

HISTORY:
  v1.0 (2019-03-14): Initial version
    - SELECT * FROM dbo.OldCustomer WHERE Active = 1
    - INSERT INTO dbo.DeprecatedSummary SELECT * FROM dbo.LegacyOrder

  v2.0 (2020-07-22): Redesigned from scratch
    - Removed: INSERT INTO [dbo].[LegacyOrder] SELECT * FROM [dbo].[OldCustomer]
    - Added proper schema qualification
    - Added error handling

  v3.0 (2021-11-05): Performance optimization
    Old query (removed):
      SELECT c.CustomerID, o.OrderDate, SUM(o.Amount) AS Total
      FROM dbo.DeprecatedSummary s
      JOIN dbo.LegacyOrder o ON o.CustomerID = s.CustomerID
      WHERE s.IsActive = 1
      GROUP BY c.CustomerID, o.OrderDate

  v4.0 (2022-08-19): Added partitioning support
  v4.2.1 (2023-01-30): Hotfix for NULL handling

DESCRIPTION:
  Refreshes the customer order summary table from the current Customer and Order tables.
  NOTE: Do NOT use dbo.OldCustomer or dbo.LegacyOrder — those are deprecated.

USAGE:
  EXEC [dbo].[usp_RefreshCustomerOrderSummary]
    @FullRefresh = 0,  -- 0=incremental, 1=full truncate+reload
    @Cutoff      = '2023-01-01'

RETURNS: Nothing (side-effects only)

DEPENDENCIES (legacy, no longer used):
  -- FROM [dbo].[OldCustomer] c
  -- JOIN [dbo].[LegacyOrder] o ON o.CustomerID = c.CustomerID
  -- INSERT INTO [dbo].[DeprecatedSummary]

=============================================================================
*/

DECLARE @Cutoff    DATE = DATEADD(MONTH, -12, GETDATE());
DECLARE @FullRefresh BIT = 0;

-- Old approach (commented out in v2.0):
-- INSERT INTO [dbo].[DeprecatedSummary]
-- SELECT c.CustomerID, SUM(o.Total)
-- FROM [dbo].[OldCustomer] c
-- JOIN [dbo].[LegacyOrder] o ON o.CustomerID = c.CustomerID
-- GROUP BY c.CustomerID;

INSERT INTO [dbo].[CustomerOrderSummary] (
    [CustomerID],
    [FirstOrderDate],
    [LastOrderDate],
    [TotalOrders],
    [TotalAmount],
    [AvgOrderValue],
    [RefreshedAt]
)
SELECT
    c.[CustomerID],
    MIN(o.[OrderDate])   AS [FirstOrderDate],
    MAX(o.[OrderDate])   AS [LastOrderDate],
    COUNT(o.[OrderID])   AS [TotalOrders],
    SUM(o.[TotalAmount]) AS [TotalAmount],
    AVG(o.[TotalAmount]) AS [AvgOrderValue],
    GETUTCDATE()         AS [RefreshedAt]
FROM      [dbo].[Customer] AS c
LEFT JOIN [dbo].[Order]    AS o ON o.[CustomerID] = c.[CustomerID]
                                AND o.[OrderDate] >= @Cutoff
GROUP BY c.[CustomerID];
