-- GENERATED SP 141: tier=medium flags=[bracketedEverything,tempTableHeavy]
-- EXPECT  sources:[stg].[CustomerStage],[rpt].[EmployeePerf],[dbo].[Department]  targets:[rpt].[SalesSummary]  exec:[dbo].[usp_UpdateCustomer]

CREATE PROCEDURE [fin].[usp_GenMedium_141]
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
    FROM   [stg].[CustomerStage]
    WHERE  [IsDeleted] = 0;
    CREATE TABLE #RefData ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2), [ProcessedAt] DATETIME);
    INSERT INTO #RefData ([ID], [Name], [Amount], [ProcessedAt])
    SELECT [ID], [Name], ISNULL([Amount], 0), GETUTCDATE()
    FROM   [rpt].[EmployeePerf]
    WHERE  [IsDeleted] = 0;

    INSERT INTO [rpt].[SalesSummary] ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [stg].[CustomerStage] AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   [rpt].[SalesSummary] AS t
    JOIN   [rpt].[EmployeePerf] AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC [dbo].[usp_UpdateCustomer] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [stg].[CustomerStage]
    SELECT @RowCount = COUNT(*) FROM [stg].[CustomerStage] WHERE [IsDeleted] = 0;

    -- Reference read: [rpt].[EmployeePerf]
    SELECT @RowCount = COUNT(*) FROM [rpt].[EmployeePerf] WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[Department]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Department] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO