-- GENERATED SP 6: tier=tiny flags=[massiveComments]
-- EXPECT  sources:[dbo].[SalesTarget]  targets:[dbo].[Shipper]  exec:[dbo].[usp_ProcessOrder]

CREATE PROCEDURE [dbo].[usp_GenTiny_006]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
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
    INSERT INTO [dbo].[Shipper] ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   dbo.SalesTarget AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC [dbo].[usp_ProcessOrder] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: dbo.SalesTarget
    SELECT @RowCount = COUNT(*) FROM dbo.SalesTarget WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO