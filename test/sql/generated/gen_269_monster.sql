-- GENERATED SP 269: tier=monster flags=[allCaps,commentedOutSQL,weirdWhitespace,nestedSubqueries,variableTableHeavy,cursorLoop]
-- EXPECT  sources:[etl].[ExtractLog],[dbo].[SalesTarget],[dbo].[Customer],[dbo].[PriceList],[stg].[InvoiceStage]  targets:[etl].[ErrorLog],[fin].[Account],[hr].[Performance]  EXEC:[dbo].[usp_UpdateCustomer],[dbo].[usp_ReconcilePayments],[fin].[usp_PostJournal],[audit].[usp_LogAccess],[dbo].[usp_ArchiveOrders],[etl].[usp_LoadProducts],[hr].[usp_ApproveLeave],[rpt].[usp_RefreshSummary],[etl].[usp_ValidateStage]
	
CREATE PROCEDURE [dbo].[usp_GenMonster_269]

    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
	AS
BEGIN
    SET NOCOUNT ON;
	    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();
	
    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

	    DECLARE @TempBuffer TABLE ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2));
	    -- @TABLE variable populated FROM logic above — NOT a catalog dependency

    DECLARE @StagingRows TABLE ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2));
    -- @TABLE variable populated FROM logic above — NOT a catalog dependency

    -- OLD CODE (removed 2019-06-15) — kept for reference:

    -- INSERT INTO dbo.DeprecatedLog (EntityID, Action, LogDate)
    -- SELECT ID, N'PROCESS', GETDATE() FROM dbo.OldLegacyTable WHERE Status = 0
	    -- UPDATE dbo.OldFlag SET Active = 0 WHERE ProcessDate < '2019-01-01'
	    -- EXEC dbo.usp_OldArchive @cutoff = '2019-01-01'

    DECLARE cur_Process CURSOR LOCAL FAST_FORWARD FOR
	        SELECT [ID], [Name] FROM etl.ExtractLog WHERE [Status] = N'PENDING';
    
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
	
    INSERT INTO [etl].[ErrorLog] ([ID], [Name])
	    SELECT x.[ID], x.[Name]

    FROM (
        SELECT i.[ID], i.[Name], ROW_NUMBER() OVER (ORDER BY i.[UpdatedDate] DESC) AS rn
        FROM (
	            SELECT [ID], [Name], [UpdatedDate]
	            FROM   [etl].[ExtractLog]
            WHERE  [IsDeleted] = 0
	        ) AS i
	    ) AS x
	    WHERE x.rn = 1;
    SET @RowCount = @RowCount + @@ROWCOUNT;


    INSERT INTO [fin].[Account] ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
    FROM   etl.ExtractLog AS a
	    JOIN   [dbo].[SalesTarget] AS c ON c.[ID] = a.[ID]
    JOIN   [dbo].[Customer] AS d ON d.[ID] = a.[ID]
	    WHERE  a.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;


    INSERT INTO hr.Performance ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
	        ISNULL(a.[Amount], 0) AS Amount,

        GETUTCDATE()    AS LoadedAt
	    FROM   etl.ExtractLog AS a
    JOIN   dbo.SalesTarget AS c ON c.[ID] = a.[ID]
    JOIN   [dbo].[Customer] AS d ON d.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
	    SET @RowCount = @RowCount + @@ROWCOUNT;

	    UPDATE t
    SET    t.[Status]      = s.[Status],
	           t.[UpdatedDate] = GETUTCDATE()
    FROM   [etl].[ErrorLog] AS t
    JOIN   [dbo].[SalesTarget] AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
	    SET @RowCount = @RowCount + @@ROWCOUNT;


    MERGE INTO [hr].[Performance] AS tgt
    USING stg.InvoiceStage AS src ON src.[ID] = tgt.[ID]
	    WHEN MATCHED THEN
	        UPDATE SET tgt.[Name] = src.[Name], tgt.[UpdatedDate] = GETUTCDATE()
    WHEN NOT MATCHED BY TARGET THEN
        INSERT ([ID], [Name], [CreatedDate]) VALUES (src.[ID], src.[Name], GETUTCDATE())
    WHEN NOT MATCHED BY SOURCE THEN
	        UPDATE SET tgt.[IsDeleted] = 1;


    EXEC dbo.usp_UpdateCustomer @ProcessDate = GETDATE(), @BatchID = @BatchID;

	    EXEC [dbo].[usp_ReconcilePayments] @ProcessDate = GETDATE(), @BatchID = @BatchID;


    EXEC [fin].[usp_PostJournal] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [audit].[usp_LogAccess] @ProcessDate = GETDATE(), @BatchID = @BatchID;

	    EXEC [dbo].[usp_ArchiveOrders] @ProcessDate = GETDATE(), @BatchID = @BatchID;
	
	    EXEC etl.usp_LoadProducts @ProcessDate = GETDATE(), @BatchID = @BatchID;



    EXEC hr.usp_ApproveLeave @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC rpt.usp_RefreshSummary @ProcessDate = GETDATE(), @BatchID = @BatchID;
	
    EXEC etl.usp_ValidateStage @ProcessDate = GETDATE(), @BatchID = @BatchID;

	    -- Reference read: [etl].[ExtractLog]
	    SELECT @RowCount = COUNT(*) FROM etl.ExtractLog WHERE [IsDeleted] = 0;
	
    -- Reference read: dbo.SalesTarget

    SELECT @RowCount = COUNT(*) FROM dbo.SalesTarget WHERE [IsDeleted] = 0;

	    -- Reference read: dbo.Customer
    SELECT @RowCount = COUNT(*) FROM dbo.Customer WHERE [IsDeleted] = 0;
	
    -- Reference read: [dbo].[PriceList]
    SELECT @RowCount = COUNT(*) FROM dbo.PriceList WHERE [IsDeleted] = 0;
	
    -- Reference read: stg.InvoiceStage
    SELECT @RowCount = COUNT(*) FROM stg.InvoiceStage WHERE [IsDeleted] = 0;

    SELECT	@RowCount   =  @RowCount + 0;  -- padding stmt

    RETURN @RowCount;
END
GO