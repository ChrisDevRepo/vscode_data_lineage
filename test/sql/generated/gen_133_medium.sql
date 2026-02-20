-- GENERATED SP 133: tier=medium flags=[bracketedEverything,tempTableHeavy]
-- EXPECT  sources:[rpt].[CustomerChurn],[stg].[CustomerStage]  targets:[stg].[ProductStage]  exec:[etl].[usp_LoadProducts]

CREATE PROCEDURE [etl].[usp_GenMedium_133]
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
    FROM   [rpt].[CustomerChurn]
    WHERE  [IsDeleted] = 0;
    CREATE TABLE #RefData ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2), [ProcessedAt] DATETIME);
    INSERT INTO #RefData ([ID], [Name], [Amount], [ProcessedAt])
    SELECT [ID], [Name], ISNULL([Amount], 0), GETUTCDATE()
    FROM   [stg].[CustomerStage]
    WHERE  [IsDeleted] = 0;

    INSERT INTO [stg].[ProductStage] ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [rpt].[CustomerChurn] AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   [stg].[ProductStage] AS t
    JOIN   [stg].[CustomerStage] AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC [etl].[usp_LoadProducts] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [rpt].[CustomerChurn]
    SELECT @RowCount = COUNT(*) FROM [rpt].[CustomerChurn] WHERE [IsDeleted] = 0;

    -- Reference read: [stg].[CustomerStage]
    SELECT @RowCount = COUNT(*) FROM [stg].[CustomerStage] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO