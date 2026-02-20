-- GENERATED SP 35: tier=tiny flags=[weirdWhitespace]
-- EXPECT  sources:[dbo].[SalesTarget]  targets:[dbo].[Category]  exec:[rpt].[usp_RefreshSummary]
	
	CREATE PROCEDURE [hr].[usp_GenTiny_035]

    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
	AS
	BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

	    DECLARE @RowCount INT = 0;
	    DECLARE @StartTime DATETIME = GETUTCDATE();


    INSERT INTO [dbo].[Category] ([SourceID], [SourceName], [LoadedAt])
	    SELECT s.[ID], s.[Name], GETUTCDATE()
	    FROM   dbo.SalesTarget AS s
    WHERE  s.[IsDeleted] = 0;

    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC [rpt].[usp_RefreshSummary] @ProcessDate = GETDATE(), @BatchID = @BatchID;



    -- Reference read: dbo.SalesTarget
	    SELECT @RowCount = COUNT(*) FROM [dbo].[SalesTarget] WHERE [IsDeleted] = 0;

    SELECT	@RowCount   =  @RowCount + 0;  -- padding stmt

	    RETURN @RowCount;
END
GO