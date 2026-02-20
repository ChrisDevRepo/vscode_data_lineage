-- GENERATED SP 286: tier=dmv_style flags=[allCaps,weirdWhitespace]
-- EXPECT  sources:[rpt].[SalesSummary],[audit].[AccessLog],[hr].[Department],[ops].[Inventory]  targets:[dbo].[Order]  EXEC:[dbo].[usp_GenerateInvoice]

	SET NOCOUNT ON;

CREATE OR ALTER PROCEDURE [ops].[usp_GenDmv_style_286]
	    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
WITH EXECUTE AS OWNER
AS
	BEGIN
    SET NOCOUNT ON;

    SET XACT_ABORT ON;

    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    INSERT INTO dbo.Order ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [rpt].[SalesSummary] AS s

    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()

    FROM   dbo.Order AS t
    JOIN   [audit].[AccessLog] AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
	    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC dbo.usp_GenerateInvoice @ProcessDate = GETDATE(), @BatchID = @BatchID;

	    -- Reference read: rpt.SalesSummary
    SELECT @RowCount = COUNT(*) FROM rpt.SalesSummary WHERE [IsDeleted] = 0;
	
    -- Reference read: audit.AccessLog
	    SELECT @RowCount = COUNT(*) FROM [audit].[AccessLog] WHERE [IsDeleted] = 0;
	
    -- Reference read: hr.Department
    SELECT @RowCount = COUNT(*) FROM hr.Department WHERE [IsDeleted] = 0;


    -- Reference read: [ops].[Inventory]
	    SELECT @RowCount = COUNT(*) FROM [ops].[Inventory] WHERE [IsDeleted] = 0;

    SELECT	@RowCount   =  @RowCount + 0;  -- padding stmt

	    RETURN @RowCount;
END
	GO