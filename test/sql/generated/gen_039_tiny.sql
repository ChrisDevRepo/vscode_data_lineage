-- GENERATED SP 39: tier=tiny flags=[printStatements]
-- EXPECT  sources:[rpt].[RegionMetrics],[stg].[OrderStage]  targets:[dbo].[Transaction]  exec:[dbo].[usp_ArchiveOrders]

CREATE PROCEDURE [etl].[usp_GenTiny_039]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    INSERT INTO dbo.Transaction ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   rpt.RegionMetrics AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    PRINT N'Step 1: Processing batch @BatchID = ' + CAST(@BatchID AS NVARCHAR) + N', elapsed: ' + CAST(DATEDIFF(ms, @StartTime, GETUTCDATE()) AS NVARCHAR) + N' ms';

    EXEC dbo.usp_ArchiveOrders @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: rpt.RegionMetrics
    SELECT @RowCount = COUNT(*) FROM rpt.RegionMetrics WHERE [IsDeleted] = 0;

    -- Reference read: [stg].[OrderStage]
    SELECT @RowCount = COUNT(*) FROM stg.OrderStage WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO