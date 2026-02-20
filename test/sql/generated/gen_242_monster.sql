-- GENERATED SP 242: tier=monster flags=[variableTableHeavy,tempTableHeavy,bracketedEverything,transactionBlocks,noBrackets,printStatements]
-- EXPECT  sources:[dbo].[Department],[hr].[Position],[dbo].[SalesTarget],[dbo].[Contact],[dbo].[Warehouse],[etl].[LoadLog]  targets:[hr].[LeaveRequest],[stg].[InvoiceStage],[dbo].[Region]  exec:[dbo].[usp_ReconcilePayments],[dbo].[usp_ProcessOrder],[etl].[usp_LoadCustomers],[hr].[usp_ApproveLeave],[dbo].[usp_GenerateInvoice],[dbo].[usp_ArchiveOrders],[dbo].[usp_ApplyDiscount],[rpt].[usp_RefreshSummary],[etl].[usp_LoadProducts],[etl].[usp_ValidateStage]

CREATE PROCEDURE [fin].[usp_GenMonster_242]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    DECLARE @TempBuffer TABLE ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2));
    -- @table variable populated from logic above — not a catalog dependency
    DECLARE @StagingRows TABLE ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2));
    -- @table variable populated from logic above — not a catalog dependency

    -- Pre-stage data in temp tables
    CREATE TABLE #WorkSet ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2), [ProcessedAt] DATETIME);
    INSERT INTO #WorkSet ([ID], [Name], [Amount], [ProcessedAt])
    SELECT [ID], [Name], ISNULL([Amount], 0), GETUTCDATE()
    FROM   [dbo].[Department]
    WHERE  [IsDeleted] = 0;
    CREATE TABLE #RefData ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2), [ProcessedAt] DATETIME);
    INSERT INTO #RefData ([ID], [Name], [Amount], [ProcessedAt])
    SELECT [ID], [Name], ISNULL([Amount], 0), GETUTCDATE()
    FROM   [hr].[Position]
    WHERE  [IsDeleted] = 0;

    BEGIN TRANSACTION;
    INSERT INTO [hr].[LeaveRequest] ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [dbo].[Department] AS s
    WHERE  s.[IsDeleted] = 0;
    IF @@ERROR = 0
        COMMIT TRANSACTION;
    ELSE
        ROLLBACK TRANSACTION;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    PRINT N'Step 1: Processing batch @BatchID = ' + CAST(@BatchID AS NVARCHAR) + N', elapsed: ' + CAST(DATEDIFF(ms, @StartTime, GETUTCDATE()) AS NVARCHAR) + N' ms';

    INSERT INTO [stg].[InvoiceStage] ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
    FROM   [dbo].[Department] AS a
    JOIN   [hr].[Position] AS c ON c.[ID] = a.[ID]
    JOIN   [dbo].[SalesTarget] AS d ON d.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    PRINT N'Step 2: Processing batch @BatchID = ' + CAST(@BatchID AS NVARCHAR) + N', elapsed: ' + CAST(DATEDIFF(ms, @StartTime, GETUTCDATE()) AS NVARCHAR) + N' ms';

    INSERT INTO [dbo].[Region] ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
    FROM   [dbo].[Department] AS a
    JOIN   [hr].[Position] AS c ON c.[ID] = a.[ID]
    JOIN   [dbo].[SalesTarget] AS d ON d.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    PRINT N'Step 3: Processing batch @BatchID = ' + CAST(@BatchID AS NVARCHAR) + N', elapsed: ' + CAST(DATEDIFF(ms, @StartTime, GETUTCDATE()) AS NVARCHAR) + N' ms';

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   [hr].[LeaveRequest] AS t
    JOIN   [hr].[Position] AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    MERGE INTO [dbo].[Region] AS tgt
    USING [etl].[LoadLog] AS src ON src.[ID] = tgt.[ID]
    WHEN MATCHED THEN
        UPDATE SET tgt.[Name] = src.[Name], tgt.[UpdatedDate] = GETUTCDATE()
    WHEN NOT MATCHED BY TARGET THEN
        INSERT ([ID], [Name], [CreatedDate]) VALUES (src.[ID], src.[Name], GETUTCDATE())
    WHEN NOT MATCHED BY SOURCE THEN
        UPDATE SET tgt.[IsDeleted] = 1;

    EXEC [dbo].[usp_ReconcilePayments] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [dbo].[usp_ProcessOrder] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [etl].[usp_LoadCustomers] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [hr].[usp_ApproveLeave] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [dbo].[usp_GenerateInvoice] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [dbo].[usp_ArchiveOrders] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [dbo].[usp_ApplyDiscount] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [rpt].[usp_RefreshSummary] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [etl].[usp_LoadProducts] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [etl].[usp_ValidateStage] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [dbo].[Department]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Department] WHERE [IsDeleted] = 0;

    -- Reference read: [hr].[Position]
    SELECT @RowCount = COUNT(*) FROM [hr].[Position] WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[SalesTarget]
    SELECT @RowCount = COUNT(*) FROM [dbo].[SalesTarget] WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[Contact]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Contact] WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[Warehouse]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Warehouse] WHERE [IsDeleted] = 0;

    -- Reference read: [etl].[LoadLog]
    SELECT @RowCount = COUNT(*) FROM [etl].[LoadLog] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO