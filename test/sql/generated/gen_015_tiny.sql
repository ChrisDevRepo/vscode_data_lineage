-- GENERATED SP 15: tier=tiny flags=[weirdWhitespace]
-- EXPECT  sources:[hr].[Employee],[dbo].[Invoice]  targets:[rpt].[SalesSummary]  exec:[etl].[usp_LoadCustomers]
	
CREATE PROCEDURE [fin].[usp_GenTiny_015]
	    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
	BEGIN
	    SET NOCOUNT ON;
	    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();


	    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    INSERT INTO [rpt].[SalesSummary] ([SourceID], [SourceName], [LoadedAt])

    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [hr].[Employee] AS s

    WHERE  s.[IsDeleted] = 0;
	    SET @RowCount = @RowCount + @@ROWCOUNT;
	
    EXEC etl.usp_LoadCustomers @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [hr].[Employee]

    SELECT @RowCount = COUNT(*) FROM hr.Employee WHERE [IsDeleted] = 0;

	    -- Reference read: [dbo].[Invoice]
    SELECT @RowCount = COUNT(*) FROM dbo.Invoice WHERE [IsDeleted] = 0;


    SELECT	@RowCount   =  @RowCount + 0;  -- padding stmt


    RETURN @RowCount;
END
GO