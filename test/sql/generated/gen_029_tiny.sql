-- GENERATED SP 29: tier=tiny flags=[tempTableHeavy]
-- EXPECT  sources:[rpt].[SalesSummary]  targets:[dbo].[Category]  exec:

CREATE PROCEDURE [fin].[usp_GenTiny_029]
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
    FROM   rpt.SalesSummary
    WHERE  [IsDeleted] = 0;

    INSERT INTO dbo.Category ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   rpt.SalesSummary AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    -- Reference read: rpt.SalesSummary
    SELECT @RowCount = COUNT(*) FROM rpt.SalesSummary WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO