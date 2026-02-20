-- GENERATED SP 267: tier=monster flags=[noCaps,allCaps,transactionBlocks,tempTableHeavy,massiveComments,commentedOutSQL]
-- EXPECT  sources:[rpt].[RegionMetrics],[dbo].[Category],[dbo].[Department],[dbo].[Payment],[fin].[TRANSACTION],[hr].[Position],[dbo].[SalesTarget],[ops].[PickList]  targets:[dbo].[Shipper],[dbo].[PriceList],[stg].[InvoiceStage],[fin].[JournalEntry]  EXEC:[dbo].[usp_ApplyDiscount],[fin].[usp_PostJournal],[etl].[usp_ValidateStage],[audit].[usp_LogAccess],[rpt].[usp_RefreshSummary],[audit].[usp_LogChange],[dbo].[usp_ArchiveOrders],[dbo].[usp_ProcessOrder]

CREATE PROCEDURE [ops].[usp_GenMonster_267]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    -- Pre-stage data IN temp tables
    CREATE TABLE #WorkSet ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2), [ProcessedAt] DATETIME);
    INSERT INTO #WorkSet ([ID], [Name], [Amount], [ProcessedAt])
    SELECT [ID], [Name], ISNULL([Amount], 0), GETUTCDATE()
    FROM   rpt.RegionMetrics
    WHERE  [IsDeleted] = 0;
    CREATE TABLE #RefData ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2), [ProcessedAt] DATETIME);
    INSERT INTO #RefData ([ID], [Name], [Amount], [ProcessedAt])
    SELECT [ID], [Name], ISNULL([Amount], 0), GETUTCDATE()
    FROM   [dbo].[Category]
    WHERE  [IsDeleted] = 0;

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
     * LEGACY NOTE: The following was removed IN v3.2:
     *   -- INSERT INTO dbo.OldArchive SELECT * FROM dbo.Deprecated WHERE Status = 1
     *   -- UPDATE dbo.Legacy SET Flag = 0
     *
     * Do NOT re-enable the above — TABLE dbo.OldArchive was dropped 2020-04-01
     */
    BEGIN TRANSACTION;
    INSERT INTO [dbo].[Shipper] ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [rpt].[RegionMetrics] AS s
    WHERE  s.[IsDeleted] = 0;
    IF @@ERROR = 0
        COMMIT TRANSACTION;
    ELSE
        ROLLBACK TRANSACTION;
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
    INSERT INTO dbo.PriceList ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
    FROM   [rpt].[RegionMetrics] AS a
    JOIN   dbo.Category AS c ON c.[ID] = a.[ID]
    JOIN   dbo.Department AS d ON d.[ID] = a.[ID]
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
    INSERT INTO [stg].[InvoiceStage] ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
    FROM   [rpt].[RegionMetrics] AS a
    JOIN   dbo.Category AS c ON c.[ID] = a.[ID]
    JOIN   [dbo].[Department] AS d ON d.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    /*
     * ─── Processing Block 4 ─────────────────────────────────────────────────
     * This section handles the core ETL for batch 4.
     * Original implementation: 2015-03-12 (developer: J.Smith)
     * Last modified: 2022-11-08 (developer: M.Jones) — added retry logic
     *
     * LEGACY NOTE: The following was removed IN v3.2:
     *   -- INSERT INTO dbo.OldArchive SELECT * FROM dbo.Deprecated WHERE Status = 1
     *   -- UPDATE dbo.Legacy SET Flag = 0
     *
     * Do NOT re-enable the above — TABLE dbo.OldArchive was dropped 2020-04-01
     */
    INSERT INTO fin.JournalEntry ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
    FROM   rpt.RegionMetrics AS a
    JOIN   dbo.Category AS c ON c.[ID] = a.[ID]
    JOIN   [dbo].[Department] AS d ON d.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    /*
     * ─── Processing Block 5 ─────────────────────────────────────────────────
     * This section handles the core ETL for batch 5.
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
    FROM   [dbo].[Shipper] AS t
    JOIN   dbo.Category AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    /*
     * ─── Processing Block 6 ─────────────────────────────────────────────────
     * This section handles the core ETL for batch 6.
     * Original implementation: 2015-03-12 (developer: J.Smith)
     * Last modified: 2022-11-08 (developer: M.Jones) — added retry logic
     *
     * LEGACY NOTE: The following was removed IN v3.2:
     *   -- INSERT INTO dbo.OldArchive SELECT * FROM dbo.Deprecated WHERE Status = 1
     *   -- UPDATE dbo.Legacy SET Flag = 0
     *
     * Do NOT re-enable the above — TABLE dbo.OldArchive was dropped 2020-04-01
     */
    MERGE INTO [fin].[JournalEntry] AS tgt
    USING ops.PickList AS src ON src.[ID] = tgt.[ID]
    WHEN MATCHED THEN
        UPDATE SET tgt.[Name] = src.[Name], tgt.[UpdatedDate] = GETUTCDATE()
    WHEN NOT MATCHED BY TARGET THEN
        INSERT ([ID], [Name], [CreatedDate]) VALUES (src.[ID], src.[Name], GETUTCDATE())
    WHEN NOT MATCHED BY SOURCE THEN
        UPDATE SET tgt.[IsDeleted] = 1;

    EXEC [dbo].[usp_ApplyDiscount] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [fin].[usp_PostJournal] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [etl].[usp_ValidateStage] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC audit.usp_LogAccess @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC rpt.usp_RefreshSummary @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [audit].[usp_LogChange] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC dbo.usp_ArchiveOrders @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC dbo.usp_ProcessOrder @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: rpt.RegionMetrics
    SELECT @RowCount = COUNT(*) FROM [rpt].[RegionMetrics] WHERE [IsDeleted] = 0;

    -- Reference read: dbo.Category
    SELECT @RowCount = COUNT(*) FROM [dbo].[Category] WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[Department]
    SELECT @RowCount = COUNT(*) FROM dbo.Department WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[Payment]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Payment] WHERE [IsDeleted] = 0;

    -- Reference read: fin.TRANSACTION
    SELECT @RowCount = COUNT(*) FROM [fin].[TRANSACTION] WHERE [IsDeleted] = 0;

    -- Reference read: hr.Position
    SELECT @RowCount = COUNT(*) FROM [hr].[Position] WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[SalesTarget]
    SELECT @RowCount = COUNT(*) FROM dbo.SalesTarget WHERE [IsDeleted] = 0;

    -- Reference read: ops.PickList
    SELECT @RowCount = COUNT(*) FROM ops.PickList WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO