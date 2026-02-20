-- GENERATED SP 42: tier=tiny flags=[tempTableHeavy]
-- EXPECT  sources:[dbo].[Employee],[dbo].[Customer]  targets:[dbo].[Contact]  exec:

CREATE PROCEDURE [rpt].[usp_GenTiny_042]
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
    FROM   dbo.Employee
    WHERE  [IsDeleted] = 0;
    CREATE TABLE #RefData ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2), [ProcessedAt] DATETIME);
    INSERT INTO #RefData ([ID], [Name], [Amount], [ProcessedAt])
    SELECT [ID], [Name], ISNULL([Amount], 0), GETUTCDATE()
    FROM   dbo.Customer
    WHERE  [IsDeleted] = 0;

    INSERT INTO dbo.Contact ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   dbo.Employee AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    -- Reference read: [dbo].[Employee]
    SELECT @RowCount = COUNT(*) FROM dbo.Employee WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[Customer]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Customer] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO