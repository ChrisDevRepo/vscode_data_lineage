-- GENERATED SP 33: tier=tiny flags=[tempTableHeavy]
-- EXPECT  sources:[hr].[Department]  targets:[dbo].[Warehouse]  exec:[fin].[usp_PostJournal]

CREATE PROCEDURE [ops].[usp_GenTiny_033]
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
    FROM   [hr].[Department]
    WHERE  [IsDeleted] = 0;

    INSERT INTO [dbo].[Warehouse] ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   hr.Department AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC [fin].[usp_PostJournal] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [hr].[Department]
    SELECT @RowCount = COUNT(*) FROM hr.Department WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO