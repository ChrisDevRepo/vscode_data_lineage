-- GENERATED SP 178: tier=large flags=[tempTableHeavy,printStatements,cursorLoop]
-- EXPECT  sources:[rpt].[MonthlyOrders],[hr].[LeaveRequest],[stg].[ProductStage],[dbo].[Shipper],[fin].[CostCenter]  targets:[dbo].[Department],[ops].[Inventory],[etl].[ErrorLog]  exec:[fin].[usp_PostJournal],[etl].[usp_LoadOrders],[dbo].[usp_ArchiveOrders],[audit].[usp_LogChange],[dbo].[usp_ApplyDiscount],[rpt].[usp_RefreshSummary]

CREATE PROCEDURE [hr].[usp_GenLarge_178]
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
    FROM   rpt.MonthlyOrders
    WHERE  [IsDeleted] = 0;
    CREATE TABLE #RefData ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2), [ProcessedAt] DATETIME);
    INSERT INTO #RefData ([ID], [Name], [Amount], [ProcessedAt])
    SELECT [ID], [Name], ISNULL([Amount], 0), GETUTCDATE()
    FROM   hr.LeaveRequest
    WHERE  [IsDeleted] = 0;

    DECLARE cur_Process CURSOR LOCAL FAST_FORWARD FOR
        SELECT [ID], [Name] FROM [rpt].[MonthlyOrders] WHERE [Status] = N'PENDING';
    
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

    INSERT INTO dbo.Department ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   rpt.MonthlyOrders AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    PRINT N'Step 2: Processing batch @BatchID = ' + CAST(@BatchID AS NVARCHAR) + N', elapsed: ' + CAST(DATEDIFF(ms, @StartTime, GETUTCDATE()) AS NVARCHAR) + N' ms';

    INSERT INTO ops.Inventory ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
    FROM   rpt.MonthlyOrders AS a
    JOIN   [hr].[LeaveRequest] AS c ON c.[ID] = a.[ID]
    JOIN   stg.ProductStage AS d ON d.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    PRINT N'Step 3: Processing batch @BatchID = ' + CAST(@BatchID AS NVARCHAR) + N', elapsed: ' + CAST(DATEDIFF(ms, @StartTime, GETUTCDATE()) AS NVARCHAR) + N' ms';

    INSERT INTO etl.ErrorLog ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
    FROM   rpt.MonthlyOrders AS a
    JOIN   [hr].[LeaveRequest] AS c ON c.[ID] = a.[ID]
    JOIN   [stg].[ProductStage] AS d ON d.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    PRINT N'Step 4: Processing batch @BatchID = ' + CAST(@BatchID AS NVARCHAR) + N', elapsed: ' + CAST(DATEDIFF(ms, @StartTime, GETUTCDATE()) AS NVARCHAR) + N' ms';

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   [dbo].[Department] AS t
    JOIN   [hr].[LeaveRequest] AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    MERGE INTO [etl].[ErrorLog] AS tgt
    USING fin.CostCenter AS src ON src.[ID] = tgt.[ID]
    WHEN MATCHED THEN
        UPDATE SET tgt.[Name] = src.[Name], tgt.[UpdatedDate] = GETUTCDATE()
    WHEN NOT MATCHED BY TARGET THEN
        INSERT ([ID], [Name], [CreatedDate]) VALUES (src.[ID], src.[Name], GETUTCDATE())
    WHEN NOT MATCHED BY SOURCE THEN
        UPDATE SET tgt.[IsDeleted] = 1;

    EXEC [fin].[usp_PostJournal] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [etl].[usp_LoadOrders] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [dbo].[usp_ArchiveOrders] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [audit].[usp_LogChange] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC dbo.usp_ApplyDiscount @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC rpt.usp_RefreshSummary @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: rpt.MonthlyOrders
    SELECT @RowCount = COUNT(*) FROM [rpt].[MonthlyOrders] WHERE [IsDeleted] = 0;

    -- Reference read: hr.LeaveRequest
    SELECT @RowCount = COUNT(*) FROM [hr].[LeaveRequest] WHERE [IsDeleted] = 0;

    -- Reference read: [stg].[ProductStage]
    SELECT @RowCount = COUNT(*) FROM [stg].[ProductStage] WHERE [IsDeleted] = 0;

    -- Reference read: dbo.Shipper
    SELECT @RowCount = COUNT(*) FROM [dbo].[Shipper] WHERE [IsDeleted] = 0;

    -- Reference read: [fin].[CostCenter]
    SELECT @RowCount = COUNT(*) FROM fin.CostCenter WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO