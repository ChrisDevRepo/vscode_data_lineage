-- GENERATED SP 214: tier=large flags=[massiveComments,cursorLoop,allCaps]
-- EXPECT  sources:[dbo].[Department],[hr].[Employee],[dbo].[Product],[dbo].[Account],[hr].[LeaveRequest]  targets:[dbo].[Shipper],[rpt].[RegionMetrics]  EXEC:[etl].[usp_LoadProducts],[dbo].[usp_GenerateInvoice],[audit].[usp_LogChange],[etl].[usp_LoadOrders],[dbo].[usp_ApplyDiscount],[fin].[usp_PostJournal]

CREATE PROCEDURE [hr].[usp_GenLarge_214]
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
    DECLARE cur_Process CURSOR LOCAL FAST_FORWARD FOR
        SELECT [ID], [Name] FROM [dbo].[Department] WHERE [Status] = N'PENDING';
    
    DECLARE @CurID INT, @CurName NVARCHAR(200);
    OPEN cur_Process;
    FETCH NEXT FROM cur_Process INTO @CurID, @CurName;
    WHILE @@FETCH_STATUS = 0
    BEGIN
        -- Process each row
        SET @BatchID = @CurID;
        PRINT N'Processing: ' + ISNULL(@CurName, N'NULL');
        FETCH NEXT FROM cur_Process INTO @CurID, @CurName;
    END
    CLOSE cur_Process;
    DEALLOCATE cur_Process;

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
    INSERT INTO dbo.Shipper ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [dbo].[Department] AS s
    WHERE  s.[IsDeleted] = 0;
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
    INSERT INTO rpt.RegionMetrics ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
    FROM   dbo.Department AS a
    JOIN   hr.Employee AS c ON c.[ID] = a.[ID]
    JOIN   [dbo].[Product] AS d ON d.[ID] = a.[ID]
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
    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   [dbo].[Shipper] AS t
    JOIN   [hr].[Employee] AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
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
    MERGE INTO [rpt].[RegionMetrics] AS tgt
    USING [hr].[LeaveRequest] AS src ON src.[ID] = tgt.[ID]
    WHEN MATCHED THEN
        UPDATE SET tgt.[Name] = src.[Name], tgt.[UpdatedDate] = GETUTCDATE()
    WHEN NOT MATCHED BY TARGET THEN
        INSERT ([ID], [Name], [CreatedDate]) VALUES (src.[ID], src.[Name], GETUTCDATE())
    WHEN NOT MATCHED BY SOURCE THEN
        UPDATE SET tgt.[IsDeleted] = 1;

    EXEC [etl].[usp_LoadProducts] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC dbo.usp_GenerateInvoice @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC audit.usp_LogChange @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC etl.usp_LoadOrders @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC dbo.usp_ApplyDiscount @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [fin].[usp_PostJournal] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: dbo.Department
    SELECT @RowCount = COUNT(*) FROM [dbo].[Department] WHERE [IsDeleted] = 0;

    -- Reference read: [hr].[Employee]
    SELECT @RowCount = COUNT(*) FROM hr.Employee WHERE [IsDeleted] = 0;

    -- Reference read: dbo.Product
    SELECT @RowCount = COUNT(*) FROM dbo.Product WHERE [IsDeleted] = 0;

    -- Reference read: dbo.Account
    SELECT @RowCount = COUNT(*) FROM dbo.Account WHERE [IsDeleted] = 0;

    -- Reference read: hr.LeaveRequest
    SELECT @RowCount = COUNT(*) FROM hr.LeaveRequest WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO