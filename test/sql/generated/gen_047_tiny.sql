-- GENERATED SP 47: tier=tiny flags=[printStatements]
-- EXPECT  sources:[fin].[Budget]  targets:[dbo].[Warehouse]  exec:[rpt].[usp_RefreshSummary]

CREATE PROCEDURE [etl].[usp_GenTiny_047]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    INSERT INTO [dbo].[Warehouse] ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [fin].[Budget] AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    PRINT N'Step 1: Processing batch @BatchID = ' + CAST(@BatchID AS NVARCHAR) + N', elapsed: ' + CAST(DATEDIFF(ms, @StartTime, GETUTCDATE()) AS NVARCHAR) + N' ms';

    EXEC [rpt].[usp_RefreshSummary] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: fin.Budget
    SELECT @RowCount = COUNT(*) FROM [fin].[Budget] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO