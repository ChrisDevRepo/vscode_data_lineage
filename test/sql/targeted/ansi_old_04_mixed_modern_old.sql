-- ANSI Old Pattern 04: Mixed old-style comma joins AND modern ANSI JOINs in same SP
-- EXPECT  sources:[dbo].[Header],[dbo].[Line],[dbo].[Lookup],[dbo].[Customer]  targets:[dbo].[Archive]  exec:[dbo].[usp_PostProcess]
-- NOTE: Modern JOINs are fully captured. Old-style comma tables after first in FROM are missed.
--       [dbo].[Header] (after FROM) and [dbo].[Customer] (after JOIN) should be found.
--       [dbo].[Line] and [dbo].[Lookup] (comma-separated after [dbo].[Header]) are likely missed.
--       Partial pass expected — a realistic mixed codebase scenario.

-- Codebase migrated partially to SQL-92 syntax but older sections remain untouched
CREATE PROCEDURE [dbo].[spArchiveOldTransactions]
    @CutoffDate DATETIME
AS
BEGIN
    -- Old-style section: written in SQL Server 2000 era, never refactored
    INSERT INTO [dbo].[Archive] (
        HeaderID, LineID, LookupCode, CustomerName, Amount, ArchivedOn
    )
    SELECT
        h.HeaderID,
        l.LineID,
        lk.Code,
        c.CustomerName,
        l.Amount,
        GETDATE()
    FROM
        [dbo].[Header]  h,    -- first table: captured by FROM rule
        [dbo].[Line]    l,    -- missed by current parser
        [dbo].[Lookup]  lk    -- missed by current parser
    JOIN [dbo].[Customer] c   -- modern JOIN: captured
        ON c.CustomerID = h.CustomerID
    WHERE
        h.HeaderID  = l.HeaderID
    AND l.LookupID  = lk.LookupID
    AND h.TxDate    < @CutoffDate
    AND h.Processed = 1;

    EXEC [dbo].[usp_PostProcess] @CutoffDate = @CutoffDate;
END
GO
