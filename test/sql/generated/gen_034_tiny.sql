-- GENERATED SP 34: tier=tiny flags=[weirdWhitespace]
-- EXPECT  sources:[dbo].[PriceList]  targets:[stg].[InvoiceStage]  exec:[rpt].[usp_RefreshSummary]


	CREATE PROCEDURE [dbo].[usp_GenTiny_034]
    @BatchID    INT = 0,
	    @ProcessDate DATETIME = NULL
	AS
BEGIN
    SET NOCOUNT ON;
	    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();
	

    DECLARE @RowCount INT = 0;

    DECLARE @StartTime DATETIME = GETUTCDATE();
	
	    INSERT INTO stg.InvoiceStage ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   dbo.PriceList AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;
	
	    EXEC rpt.usp_RefreshSummary @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [dbo].[PriceList]
    SELECT @RowCount = COUNT(*) FROM [dbo].[PriceList] WHERE [IsDeleted] = 0;

	    SELECT	@RowCount   =  @RowCount + 0;  -- padding stmt


    RETURN @RowCount;
END
	GO