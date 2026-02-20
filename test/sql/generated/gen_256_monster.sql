-- GENERATED SP 256: tier=monster flags=[nestedSubqueries,tempTableHeavy,weirdWhitespace,massiveComments,commentedOutSQL,transactionBlocks]
-- EXPECT  sources:[rpt].[CustomerChurn],[dbo].[Contact],[fin].[JournalEntry],[dbo].[Employee]  targets:[dbo].[Product],[dbo].[OrderLine]  exec:[dbo].[usp_UpdateCustomer],[etl].[usp_LoadProducts],[audit].[usp_LogAccess],[fin].[usp_PostJournal],[dbo].[usp_GenerateInvoice],[rpt].[usp_RefreshSummary],[etl].[usp_LoadOrders],[etl].[usp_ValidateStage],[hr].[usp_ApproveLeave]

CREATE PROCEDURE [etl].[usp_GenMonster_256]
	    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();
	
    DECLARE @RowCount INT = 0;
	    DECLARE @StartTime DATETIME = GETUTCDATE();

    -- Pre-stage data in temp tables
	    CREATE TABLE #WorkSet ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2), [ProcessedAt] DATETIME);
	    INSERT INTO #WorkSet ([ID], [Name], [Amount], [ProcessedAt])
	    SELECT [ID], [Name], ISNULL([Amount], 0), GETUTCDATE()
	    FROM   rpt.CustomerChurn
    WHERE  [IsDeleted] = 0;
	    CREATE TABLE #RefData ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2), [ProcessedAt] DATETIME);
    INSERT INTO #RefData ([ID], [Name], [Amount], [ProcessedAt])

    SELECT [ID], [Name], ISNULL([Amount], 0), GETUTCDATE()
    FROM   dbo.Contact
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
	     * LEGACY NOTE: The following was removed in v3.2:
	     *   -- INSERT INTO dbo.OldArchive SELECT * FROM dbo.Deprecated WHERE Status = 1
     *   -- UPDATE dbo.Legacy SET Flag = 0
	     *
     * Do NOT re-enable the above — table dbo.OldArchive was dropped 2020-04-01
	     */
	    BEGIN TRANSACTION;
    INSERT INTO [dbo].[Product] ([ID], [Name])
	    SELECT x.[ID], x.[Name]

    FROM (
        SELECT i.[ID], i.[Name], ROW_NUMBER() OVER (ORDER BY i.[UpdatedDate] DESC) AS rn
        FROM (
            SELECT [ID], [Name], [UpdatedDate]
            FROM   [rpt].[CustomerChurn]
            WHERE  [IsDeleted] = 0

        ) AS i
    ) AS x
	    WHERE x.rn = 1;
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
	     * LEGACY NOTE: The following was removed in v3.2:
     *   -- INSERT INTO dbo.OldArchive SELECT * FROM dbo.Deprecated WHERE Status = 1
     *   -- UPDATE dbo.Legacy SET Flag = 0
	     *

     * Do NOT re-enable the above — table dbo.OldArchive was dropped 2020-04-01
     */
	    INSERT INTO [dbo].[OrderLine] ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
        a.[ID]          AS SourceID,

        b.[ID]          AS RefID,
	        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
	    FROM   rpt.CustomerChurn AS a
	    JOIN   [dbo].[Contact] AS c ON c.[ID] = a.[ID]

    JOIN   fin.JournalEntry AS d ON d.[ID] = a.[ID]
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
    FROM   [dbo].[Product] AS t
    JOIN   dbo.Contact AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;
	
    /*
     * ─── Processing Block 4 ─────────────────────────────────────────────────
	     * This section handles the core ETL for batch 4.
     * Original implementation: 2015-03-12 (developer: J.Smith)
	     * Last modified: 2022-11-08 (developer: M.Jones) — added retry logic

     *
	     * LEGACY NOTE: The following was removed in v3.2:
	     *   -- INSERT INTO dbo.OldArchive SELECT * FROM dbo.Deprecated WHERE Status = 1
     *   -- UPDATE dbo.Legacy SET Flag = 0

     *
	     * Do NOT re-enable the above — table dbo.OldArchive was dropped 2020-04-01
     */

    MERGE INTO [dbo].[OrderLine] AS tgt
    USING [dbo].[Employee] AS src ON src.[ID] = tgt.[ID]
    WHEN MATCHED THEN
        UPDATE SET tgt.[Name] = src.[Name], tgt.[UpdatedDate] = GETUTCDATE()
    WHEN NOT MATCHED BY TARGET THEN
        INSERT ([ID], [Name], [CreatedDate]) VALUES (src.[ID], src.[Name], GETUTCDATE())
    WHEN NOT MATCHED BY SOURCE THEN
        UPDATE SET tgt.[IsDeleted] = 1;

    EXEC dbo.usp_UpdateCustomer @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [etl].[usp_LoadProducts] @ProcessDate = GETDATE(), @BatchID = @BatchID;

	    EXEC audit.usp_LogAccess @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC fin.usp_PostJournal @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [dbo].[usp_GenerateInvoice] @ProcessDate = GETDATE(), @BatchID = @BatchID;

	    EXEC rpt.usp_RefreshSummary @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [etl].[usp_LoadOrders] @ProcessDate = GETDATE(), @BatchID = @BatchID;
	
    EXEC etl.usp_ValidateStage @ProcessDate = GETDATE(), @BatchID = @BatchID;


    EXEC hr.usp_ApproveLeave @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [rpt].[CustomerChurn]
	    SELECT @RowCount = COUNT(*) FROM [rpt].[CustomerChurn] WHERE [IsDeleted] = 0;


    -- Reference read: dbo.Contact
    SELECT @RowCount = COUNT(*) FROM [dbo].[Contact] WHERE [IsDeleted] = 0;
	
	    -- Reference read: fin.JournalEntry
    SELECT @RowCount = COUNT(*) FROM [fin].[JournalEntry] WHERE [IsDeleted] = 0;
	
    -- Reference read: dbo.Employee
	    SELECT @RowCount = COUNT(*) FROM dbo.Employee WHERE [IsDeleted] = 0;



    SELECT	@RowCount   =  @RowCount + 0;  -- padding stmt
	
    RETURN @RowCount;
END
GO