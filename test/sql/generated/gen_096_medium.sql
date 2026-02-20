-- GENERATED SP 96: tier=medium flags=[commentedOutSQL,massiveComments]
-- EXPECT  sources:[rpt].[SalesSummary],[stg].[OrderStage],[dbo].[Invoice],[dbo].[Employee]  targets:[dbo].[Shipper]  exec:[etl].[usp_LoadProducts]

CREATE PROCEDURE [hr].[usp_GenMedium_096]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    -- OLD CODE (removed 2019-06-15) — kept for reference:
    -- INSERT INTO dbo.DeprecatedLog (EntityID, Action, LogDate)
    -- SELECT ID, N'PROCESS', GETDATE() FROM dbo.OldLegacyTable WHERE Status = 0
    -- UPDATE dbo.OldFlag SET Active = 0 WHERE ProcessDate < '2019-01-01'
    -- EXEC dbo.usp_OldArchive @cutoff = '2019-01-01'

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
    INSERT INTO [dbo].[Shipper] ([SourceID], [SourceName], [LoadedAt])
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
    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   dbo.Shipper AS t
    JOIN   [stg].[OrderStage] AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC etl.usp_LoadProducts @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: rpt.SalesSummary
    SELECT @RowCount = COUNT(*) FROM [rpt].[SalesSummary] WHERE [IsDeleted] = 0;

    -- Reference read: [stg].[OrderStage]
    SELECT @RowCount = COUNT(*) FROM stg.OrderStage WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[Invoice]
    SELECT @RowCount = COUNT(*) FROM dbo.Invoice WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[Employee]
    SELECT @RowCount = COUNT(*) FROM dbo.Employee WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO