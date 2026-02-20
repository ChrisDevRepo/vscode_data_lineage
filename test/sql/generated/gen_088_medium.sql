-- GENERATED SP 88: tier=medium flags=[tempTableHeavy,printStatements]
-- EXPECT  sources:[dbo].[PriceList],[dbo].[Employee]  targets:[fin].[JournalEntry]  exec:[etl].[usp_LoadCustomers]

CREATE PROCEDURE [rpt].[usp_GenMedium_088]
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
    FROM   dbo.PriceList
    WHERE  [IsDeleted] = 0;
    CREATE TABLE #RefData ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2), [ProcessedAt] DATETIME);
    INSERT INTO #RefData ([ID], [Name], [Amount], [ProcessedAt])
    SELECT [ID], [Name], ISNULL([Amount], 0), GETUTCDATE()
    FROM   dbo.Employee
    WHERE  [IsDeleted] = 0;

    INSERT INTO fin.JournalEntry ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [dbo].[PriceList] AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    PRINT N'Step 1: Processing batch @BatchID = ' + CAST(@BatchID AS NVARCHAR) + N', elapsed: ' + CAST(DATEDIFF(ms, @StartTime, GETUTCDATE()) AS NVARCHAR) + N' ms';

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   fin.JournalEntry AS t
    JOIN   [dbo].[Employee] AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC etl.usp_LoadCustomers @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [dbo].[PriceList]
    SELECT @RowCount = COUNT(*) FROM dbo.PriceList WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[Employee]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Employee] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO