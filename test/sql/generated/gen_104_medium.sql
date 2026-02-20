-- GENERATED SP 104: tier=medium flags=[allCaps,massiveComments]
-- EXPECT  sources:[dbo].[OrderLine],[dbo].[Region],[fin].[JournalEntry],[rpt].[MonthlyOrders]  targets:[hr].[LeaveRequest],[rpt].[CustomerChurn]  EXEC:[etl].[usp_LoadOrders],[dbo].[usp_ReconcilePayments]

CREATE PROCEDURE [etl].[usp_GenMedium_104]
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
     * LEGACY NOTE: The following was removed IN v3.2:
     *   -- INSERT INTO dbo.OldArchive SELECT * FROM dbo.Deprecated WHERE Status = 1
     *   -- UPDATE dbo.Legacy SET Flag = 0
     *
     * Do NOT re-enable the above — TABLE dbo.OldArchive was dropped 2020-04-01
     */
    INSERT INTO [hr].[LeaveRequest] ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   dbo.OrderLine AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    /*
     * ─── Processing Block 2 ─────────────────────────────────────────────────
     * This section handles the core ETL for batch 2.
     * Original implementation: 2015-03-12 (developer: J.Smith)
     * Last modified: 2022-11-08 (developer: M.Jones) — added retry logic
     *
     * LEGACY NOTE: The following was removed IN v3.2:
     *   -- INSERT INTO dbo.OldArchive SELECT * FROM dbo.Deprecated WHERE Status = 1
     *   -- UPDATE dbo.Legacy SET Flag = 0
     *
     * Do NOT re-enable the above — TABLE dbo.OldArchive was dropped 2020-04-01
     */
    INSERT INTO [rpt].[CustomerChurn] ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
    FROM   [dbo].[OrderLine] AS a
    JOIN   dbo.Region AS c ON c.[ID] = a.[ID]
    JOIN   fin.JournalEntry AS d ON d.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    /*
     * ─── Processing Block 3 ─────────────────────────────────────────────────
     * This section handles the core ETL for batch 3.
     * Original implementation: 2015-03-12 (developer: J.Smith)
     * Last modified: 2022-11-08 (developer: M.Jones) — added retry logic
     *
     * LEGACY NOTE: The following was removed IN v3.2:
     *   -- INSERT INTO dbo.OldArchive SELECT * FROM dbo.Deprecated WHERE Status = 1
     *   -- UPDATE dbo.Legacy SET Flag = 0
     *
     * Do NOT re-enable the above — TABLE dbo.OldArchive was dropped 2020-04-01
     */
    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   [hr].[LeaveRequest] AS t
    JOIN   dbo.Region AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC [etl].[usp_LoadOrders] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC dbo.usp_ReconcilePayments @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [dbo].[OrderLine]
    SELECT @RowCount = COUNT(*) FROM dbo.OrderLine WHERE [IsDeleted] = 0;

    -- Reference read: dbo.Region
    SELECT @RowCount = COUNT(*) FROM [dbo].[Region] WHERE [IsDeleted] = 0;

    -- Reference read: [fin].[JournalEntry]
    SELECT @RowCount = COUNT(*) FROM [fin].[JournalEntry] WHERE [IsDeleted] = 0;

    -- Reference read: rpt.MonthlyOrders
    SELECT @RowCount = COUNT(*) FROM rpt.MonthlyOrders WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO