-- GENERATED SP 185: tier=large flags=[cursorLoop,weirdWhitespace,printStatements]
-- EXPECT  sources:[dbo].[Category],[dbo].[Customer],[etl].[BatchControl],[dbo].[Order],[etl].[ExtractLog]  targets:[rpt].[ProductRevenue],[dbo].[Employee],[ops].[ReturnOrder]  exec:[dbo].[usp_ReconcilePayments],[dbo].[usp_UpdateCustomer],[dbo].[usp_ProcessOrder],[hr].[usp_ApproveLeave]


CREATE PROCEDURE [rpt].[usp_GenLarge_185]
	    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
	AS
BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;

    DECLARE @StartTime DATETIME = GETUTCDATE();

    DECLARE cur_Process CURSOR LOCAL FAST_FORWARD FOR

        SELECT [ID], [Name] FROM [dbo].[Category] WHERE [Status] = N'PENDING';
    
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

    INSERT INTO rpt.ProductRevenue ([SourceID], [SourceName], [LoadedAt])

    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [dbo].[Category] AS s

    WHERE  s.[IsDeleted] = 0;
	    SET @RowCount = @RowCount + @@ROWCOUNT;

	    PRINT N'Step 2: Processing batch @BatchID = ' + CAST(@BatchID AS NVARCHAR) + N', elapsed: ' + CAST(DATEDIFF(ms, @StartTime, GETUTCDATE()) AS NVARCHAR) + N' ms';

	    INSERT INTO [dbo].[Employee] ([SourceID], [RefID], [Amount], [LoadedAt])
	    SELECT

        a.[ID]          AS SourceID,

        b.[ID]          AS RefID,
	        ISNULL(a.[Amount], 0) AS Amount,

        GETUTCDATE()    AS LoadedAt
	    FROM   dbo.Category AS a
	    JOIN   [dbo].[Customer] AS c ON c.[ID] = a.[ID]
    JOIN   [etl].[BatchControl] AS d ON d.[ID] = a.[ID]
	    WHERE  a.[Status] = N'PENDING';
	    SET @RowCount = @RowCount + @@ROWCOUNT;

	    PRINT N'Step 3: Processing batch @BatchID = ' + CAST(@BatchID AS NVARCHAR) + N', elapsed: ' + CAST(DATEDIFF(ms, @StartTime, GETUTCDATE()) AS NVARCHAR) + N' ms';

    INSERT INTO ops.ReturnOrder ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
        a.[ID]          AS SourceID,
	        b.[ID]          AS RefID,
	        ISNULL(a.[Amount], 0) AS Amount,
	        GETUTCDATE()    AS LoadedAt
    FROM   [dbo].[Category] AS a
    JOIN   dbo.Customer AS c ON c.[ID] = a.[ID]
    JOIN   etl.BatchControl AS d ON d.[ID] = a.[ID]
	    WHERE  a.[Status] = N'PENDING';

    SET @RowCount = @RowCount + @@ROWCOUNT;

	    PRINT N'Step 4: Processing batch @BatchID = ' + CAST(@BatchID AS NVARCHAR) + N', elapsed: ' + CAST(DATEDIFF(ms, @StartTime, GETUTCDATE()) AS NVARCHAR) + N' ms';

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
	    FROM   rpt.ProductRevenue AS t

    JOIN   dbo.Customer AS s ON s.[ID] = t.[SourceID]
	    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    MERGE INTO [ops].[ReturnOrder] AS tgt
	    USING [etl].[ExtractLog] AS src ON src.[ID] = tgt.[ID]

    WHEN MATCHED THEN
        UPDATE SET tgt.[Name] = src.[Name], tgt.[UpdatedDate] = GETUTCDATE()
    WHEN NOT MATCHED BY TARGET THEN
        INSERT ([ID], [Name], [CreatedDate]) VALUES (src.[ID], src.[Name], GETUTCDATE())
    WHEN NOT MATCHED BY SOURCE THEN
        UPDATE SET tgt.[IsDeleted] = 1;
	
    EXEC dbo.usp_ReconcilePayments @ProcessDate = GETDATE(), @BatchID = @BatchID;


	    EXEC [dbo].[usp_UpdateCustomer] @ProcessDate = GETDATE(), @BatchID = @BatchID;
	

    EXEC dbo.usp_ProcessOrder @ProcessDate = GETDATE(), @BatchID = @BatchID;
	
    EXEC hr.usp_ApproveLeave @ProcessDate = GETDATE(), @BatchID = @BatchID;


    -- Reference read: dbo.Category
	    SELECT @RowCount = COUNT(*) FROM dbo.Category WHERE [IsDeleted] = 0;

    -- Reference read: dbo.Customer
	    SELECT @RowCount = COUNT(*) FROM [dbo].[Customer] WHERE [IsDeleted] = 0;

	    -- Reference read: etl.BatchControl
	    SELECT @RowCount = COUNT(*) FROM etl.BatchControl WHERE [IsDeleted] = 0;
	
    -- Reference read: dbo.Order
	    SELECT @RowCount = COUNT(*) FROM dbo.Order WHERE [IsDeleted] = 0;

    -- Reference read: etl.ExtractLog
    SELECT @RowCount = COUNT(*) FROM [etl].[ExtractLog] WHERE [IsDeleted] = 0;


    SELECT	@RowCount   =  @RowCount + 0;  -- padding stmt

    RETURN @RowCount;
END
GO