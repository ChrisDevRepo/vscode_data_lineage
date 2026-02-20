-- GENERATED SP 124: tier=medium flags=[tempTableHeavy,transactionBlocks]
-- EXPECT  sources:[rpt].[RegionMetrics],[etl].[BatchControl]  targets:[hr].[Employee],[dbo].[OrderLine]  exec:[dbo].[usp_ArchiveOrders],[etl].[usp_LoadOrders]

CREATE PROCEDURE [etl].[usp_GenMedium_124]
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
    FROM   rpt.RegionMetrics
    WHERE  [IsDeleted] = 0;
    CREATE TABLE #RefData ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2), [ProcessedAt] DATETIME);
    INSERT INTO #RefData ([ID], [Name], [Amount], [ProcessedAt])
    SELECT [ID], [Name], ISNULL([Amount], 0), GETUTCDATE()
    FROM   [etl].[BatchControl]
    WHERE  [IsDeleted] = 0;

    BEGIN TRANSACTION;
    INSERT INTO [hr].[Employee] ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [rpt].[RegionMetrics] AS s
    WHERE  s.[IsDeleted] = 0;
    IF @@ERROR = 0
        COMMIT TRANSACTION;
    ELSE
        ROLLBACK TRANSACTION;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    INSERT INTO [dbo].[OrderLine] ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
    FROM   [rpt].[RegionMetrics] AS a
    JOIN   [etl].[BatchControl] AS c ON c.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   [hr].[Employee] AS t
    JOIN   etl.BatchControl AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC [dbo].[usp_ArchiveOrders] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [etl].[usp_LoadOrders] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [rpt].[RegionMetrics]
    SELECT @RowCount = COUNT(*) FROM rpt.RegionMetrics WHERE [IsDeleted] = 0;

    -- Reference read: etl.BatchControl
    SELECT @RowCount = COUNT(*) FROM [etl].[BatchControl] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO