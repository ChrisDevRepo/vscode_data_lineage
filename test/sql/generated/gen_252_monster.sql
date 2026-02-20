-- GENERATED SP 252: tier=monster flags=[transactionBlocks,bracketedEverything,weirdWhitespace,printStatements,cursorLoop,tempTableHeavy]
-- EXPECT  sources:[audit].[ChangeLog],[dbo].[Category],[rpt].[RegionMetrics],[dbo].[Account],[dbo].[Product],[hr].[Performance],[dbo].[Region]  targets:[dbo].[Employee],[dbo].[OrderLine],[dbo].[Shipper],[dbo].[Address]  exec:[etl].[usp_LoadCustomers],[etl].[usp_ValidateStage],[hr].[usp_ApproveLeave],[etl].[usp_LoadProducts]

CREATE PROCEDURE [etl].[usp_GenMonster_252]
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
	    FROM   [audit].[ChangeLog]
    WHERE  [IsDeleted] = 0;
	    CREATE TABLE #RefData ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2), [ProcessedAt] DATETIME);
    INSERT INTO #RefData ([ID], [Name], [Amount], [ProcessedAt])
    SELECT [ID], [Name], ISNULL([Amount], 0), GETUTCDATE()
    FROM   [dbo].[Category]
	    WHERE  [IsDeleted] = 0;
	
    DECLARE cur_Process CURSOR LOCAL FAST_FORWARD FOR
        SELECT [ID], [Name] FROM [audit].[ChangeLog] WHERE [Status] = N'PENDING';
	    
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

    BEGIN TRANSACTION;
    INSERT INTO [dbo].[Employee] ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [audit].[ChangeLog] AS s
	    WHERE  s.[IsDeleted] = 0;
	    IF @@ERROR = 0
        COMMIT TRANSACTION;
	    ELSE
	        ROLLBACK TRANSACTION;
	    SET @RowCount = @RowCount + @@ROWCOUNT;
	
	    PRINT N'Step 2: Processing batch @BatchID = ' + CAST(@BatchID AS NVARCHAR) + N', elapsed: ' + CAST(DATEDIFF(ms, @StartTime, GETUTCDATE()) AS NVARCHAR) + N' ms';

    INSERT INTO [dbo].[OrderLine] ([SourceID], [RefID], [Amount], [LoadedAt])

    SELECT
	        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
	        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
    FROM   [audit].[ChangeLog] AS a
    JOIN   [dbo].[Category] AS c ON c.[ID] = a.[ID]
	    JOIN   [rpt].[RegionMetrics] AS d ON d.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
	    SET @RowCount = @RowCount + @@ROWCOUNT;


    PRINT N'Step 3: Processing batch @BatchID = ' + CAST(@BatchID AS NVARCHAR) + N', elapsed: ' + CAST(DATEDIFF(ms, @StartTime, GETUTCDATE()) AS NVARCHAR) + N' ms';
	
    INSERT INTO [dbo].[Shipper] ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT

        a.[ID]          AS SourceID,
	        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
    FROM   [audit].[ChangeLog] AS a
    JOIN   [dbo].[Category] AS c ON c.[ID] = a.[ID]
	    JOIN   [rpt].[RegionMetrics] AS d ON d.[ID] = a.[ID]
	    WHERE  a.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    PRINT N'Step 4: Processing batch @BatchID = ' + CAST(@BatchID AS NVARCHAR) + N', elapsed: ' + CAST(DATEDIFF(ms, @StartTime, GETUTCDATE()) AS NVARCHAR) + N' ms';

	    INSERT INTO [dbo].[Address] ([SourceID], [RefID], [Amount], [LoadedAt])
	    SELECT
	        a.[ID]          AS SourceID,
	        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
	    FROM   [audit].[ChangeLog] AS a
	    JOIN   [dbo].[Category] AS c ON c.[ID] = a.[ID]

    JOIN   [rpt].[RegionMetrics] AS d ON d.[ID] = a.[ID]
	    WHERE  a.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    PRINT N'Step 5: Processing batch @BatchID = ' + CAST(@BatchID AS NVARCHAR) + N', elapsed: ' + CAST(DATEDIFF(ms, @StartTime, GETUTCDATE()) AS NVARCHAR) + N' ms';
	
    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()

    FROM   [dbo].[Employee] AS t
    JOIN   [dbo].[Category] AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
	    SET @RowCount = @RowCount + @@ROWCOUNT;



    MERGE INTO [dbo].[Address] AS tgt
	    USING [dbo].[Region] AS src ON src.[ID] = tgt.[ID]
	    WHEN MATCHED THEN

        UPDATE SET tgt.[Name] = src.[Name], tgt.[UpdatedDate] = GETUTCDATE()
	    WHEN NOT MATCHED BY TARGET THEN
        INSERT ([ID], [Name], [CreatedDate]) VALUES (src.[ID], src.[Name], GETUTCDATE())

    WHEN NOT MATCHED BY SOURCE THEN
	        UPDATE SET tgt.[IsDeleted] = 1;

	    EXEC [etl].[usp_LoadCustomers] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [etl].[usp_ValidateStage] @ProcessDate = GETDATE(), @BatchID = @BatchID;
	
    EXEC [hr].[usp_ApproveLeave] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [etl].[usp_LoadProducts] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [audit].[ChangeLog]

    SELECT @RowCount = COUNT(*) FROM [audit].[ChangeLog] WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[Category]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Category] WHERE [IsDeleted] = 0;
	
    -- Reference read: [rpt].[RegionMetrics]
	    SELECT @RowCount = COUNT(*) FROM [rpt].[RegionMetrics] WHERE [IsDeleted] = 0;



    -- Reference read: [dbo].[Account]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Account] WHERE [IsDeleted] = 0;


	    -- Reference read: [dbo].[Product]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Product] WHERE [IsDeleted] = 0;

    -- Reference read: [hr].[Performance]
	    SELECT @RowCount = COUNT(*) FROM [hr].[Performance] WHERE [IsDeleted] = 0;
	
    -- Reference read: [dbo].[Region]
	    SELECT @RowCount = COUNT(*) FROM [dbo].[Region] WHERE [IsDeleted] = 0;

    SELECT	@RowCount   =  @RowCount + 0;  -- padding stmt
	

    RETURN @RowCount;
	END
GO