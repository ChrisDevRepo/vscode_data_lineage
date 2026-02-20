-- GENERATED SP 281: tier=dmv_style flags=[massiveComments,bracketedEverything]
-- EXPECT  sources:[rpt].[SalesSummary],[dbo].[Product],[etl].[ErrorLog],[dbo].[Warehouse]  targets:[dbo].[Contact],[dbo].[Customer]  exec:[dbo].[usp_ProcessOrder],[dbo].[usp_ApplyDiscount]

SET NOCOUNT ON;

CREATE OR ALTER PROCEDURE [hr].[usp_GenDmv_style_281]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
WITH EXECUTE AS OWNER
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    /*
     * ─── Processing Block 1 ─────────────────────────────────────────────────
     * This section handles the core ETL for batch 1.
     * Original implementation: 2015-03-12 (developer: J.Smith)
     * Last modified: 2022-11-08 (developer: M.Jones) — added retry logic
     *
     * LEGACY NOTE: The following was removed in v3.2:
     *   -- INSERT INTO dbo.OldArchive SELECT * FROM dbo.Deprecated WHERE Status = 1
     *   -- UPDATE dbo.Legacy SET Flag = 0
     *
     * Do NOT re-enable the above — table dbo.OldArchive was dropped 2020-04-01
     */
    INSERT INTO [dbo].[Contact] ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [rpt].[SalesSummary] AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    /*
     * ─── Processing Block 2 ─────────────────────────────────────────────────
     * This section handles the core ETL for batch 2.
     * Original implementation: 2015-03-12 (developer: J.Smith)
     * Last modified: 2022-11-08 (developer: M.Jones) — added retry logic
     *
     * LEGACY NOTE: The following was removed in v3.2:
     *   -- INSERT INTO dbo.OldArchive SELECT * FROM dbo.Deprecated WHERE Status = 1
     *   -- UPDATE dbo.Legacy SET Flag = 0
     *
     * Do NOT re-enable the above — table dbo.OldArchive was dropped 2020-04-01
     */
    INSERT INTO [dbo].[Customer] ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
    FROM   [rpt].[SalesSummary] AS a
    JOIN   [dbo].[Product] AS c ON c.[ID] = a.[ID]
    JOIN   [etl].[ErrorLog] AS d ON d.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    /*
     * ─── Processing Block 3 ─────────────────────────────────────────────────
     * This section handles the core ETL for batch 3.
     * Original implementation: 2015-03-12 (developer: J.Smith)
     * Last modified: 2022-11-08 (developer: M.Jones) — added retry logic
     *
     * LEGACY NOTE: The following was removed in v3.2:
     *   -- INSERT INTO dbo.OldArchive SELECT * FROM dbo.Deprecated WHERE Status = 1
     *   -- UPDATE dbo.Legacy SET Flag = 0
     *
     * Do NOT re-enable the above — table dbo.OldArchive was dropped 2020-04-01
     */
    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   [dbo].[Contact] AS t
    JOIN   [dbo].[Product] AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC [dbo].[usp_ProcessOrder] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [dbo].[usp_ApplyDiscount] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [rpt].[SalesSummary]
    SELECT @RowCount = COUNT(*) FROM [rpt].[SalesSummary] WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[Product]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Product] WHERE [IsDeleted] = 0;

    -- Reference read: [etl].[ErrorLog]
    SELECT @RowCount = COUNT(*) FROM [etl].[ErrorLog] WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[Warehouse]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Warehouse] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO