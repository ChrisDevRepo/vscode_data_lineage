-- GENERATED SP 13: tier=tiny flags=[allCaps]
-- EXPECT  sources:[dbo].[PriceList]  targets:[rpt].[SalesSummary]  EXEC:[etl].[usp_LoadCustomers]

CREATE PROCEDURE [etl].[usp_GenTiny_013]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    INSERT INTO rpt.SalesSummary ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [dbo].[PriceList] AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC etl.usp_LoadCustomers @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: dbo.PriceList
    SELECT @RowCount = COUNT(*) FROM dbo.PriceList WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO