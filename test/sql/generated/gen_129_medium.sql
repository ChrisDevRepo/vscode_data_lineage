-- GENERATED SP 129: tier=medium flags=[bracketedEverything,tempTableHeavy]
-- EXPECT  sources:[dbo].[Invoice],[stg].[CustomerStage],[dbo].[Payment]  targets:[dbo].[PriceList],[dbo].[SalesTarget]  exec:[etl].[usp_LoadOrders],[dbo].[usp_GenerateInvoice],[audit].[usp_LogChange]

CREATE PROCEDURE [fin].[usp_GenMedium_129]
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
    FROM   [dbo].[Invoice]
    WHERE  [IsDeleted] = 0;
    CREATE TABLE #RefData ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2), [ProcessedAt] DATETIME);
    INSERT INTO #RefData ([ID], [Name], [Amount], [ProcessedAt])
    SELECT [ID], [Name], ISNULL([Amount], 0), GETUTCDATE()
    FROM   [stg].[CustomerStage]
    WHERE  [IsDeleted] = 0;

    INSERT INTO [dbo].[PriceList] ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [dbo].[Invoice] AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    INSERT INTO [dbo].[SalesTarget] ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
    FROM   [dbo].[Invoice] AS a
    JOIN   [stg].[CustomerStage] AS c ON c.[ID] = a.[ID]
    JOIN   [dbo].[Payment] AS d ON d.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   [dbo].[PriceList] AS t
    JOIN   [stg].[CustomerStage] AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC [etl].[usp_LoadOrders] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [dbo].[usp_GenerateInvoice] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [audit].[usp_LogChange] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [dbo].[Invoice]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Invoice] WHERE [IsDeleted] = 0;

    -- Reference read: [stg].[CustomerStage]
    SELECT @RowCount = COUNT(*) FROM [stg].[CustomerStage] WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[Payment]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Payment] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO