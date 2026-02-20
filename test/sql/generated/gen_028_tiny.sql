-- GENERATED SP 28: tier=tiny flags=[printStatements]
-- EXPECT  sources:[ops].[Shipment]  targets:[dbo].[PriceList]  exec:[etl].[usp_LoadCustomers]

CREATE PROCEDURE [fin].[usp_GenTiny_028]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    INSERT INTO dbo.PriceList ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   ops.Shipment AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    PRINT N'Step 1: Processing batch @BatchID = ' + CAST(@BatchID AS NVARCHAR) + N', elapsed: ' + CAST(DATEDIFF(ms, @StartTime, GETUTCDATE()) AS NVARCHAR) + N' ms';

    EXEC [etl].[usp_LoadCustomers] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [ops].[Shipment]
    SELECT @RowCount = COUNT(*) FROM [ops].[Shipment] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO