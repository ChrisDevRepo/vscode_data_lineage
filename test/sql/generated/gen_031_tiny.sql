-- GENERATED SP 31: tier=tiny flags=[weirdWhitespace]
-- EXPECT  sources:[dbo].[OrderLine]  targets:[dbo].[Account]  exec:

	CREATE PROCEDURE [rpt].[usp_GenTiny_031]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
BEGIN
	    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();


    DECLARE @RowCount INT = 0;
	    DECLARE @StartTime DATETIME = GETUTCDATE();


    INSERT INTO [dbo].[Account] ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [dbo].[OrderLine] AS s
	    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;


    -- Reference read: dbo.OrderLine
	    SELECT @RowCount = COUNT(*) FROM dbo.OrderLine WHERE [IsDeleted] = 0;

    SELECT	@RowCount   =  @RowCount + 0;  -- padding stmt
	
	    RETURN @RowCount;
	END
GO