-- GENERATED SP 50: tier=tiny flags=[weirdWhitespace]
-- EXPECT  sources:[dbo].[Payment]  targets:[etl].[BatchControl]  exec:[dbo].[usp_GenerateInvoice]


CREATE PROCEDURE [etl].[usp_GenTiny_050]

    @BatchID    INT = 0,
	    @ProcessDate DATETIME = NULL
AS

BEGIN
	    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();
	
    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    INSERT INTO [etl].[BatchControl] ([SourceID], [SourceName], [LoadedAt])

    SELECT s.[ID], s.[Name], GETUTCDATE()
	    FROM   [dbo].[Payment] AS s
	    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC dbo.usp_GenerateInvoice @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: dbo.Payment
    SELECT @RowCount = COUNT(*) FROM dbo.Payment WHERE [IsDeleted] = 0;


	    SELECT	@RowCount   =  @RowCount + 0;  -- padding stmt

	    RETURN @RowCount;
	END
GO