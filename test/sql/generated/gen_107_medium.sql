-- GENERATED SP 107: tier=medium flags=[allCaps,weirdWhitespace]
-- EXPECT  sources:[fin].[Budget],[dbo].[Department],[ops].[Shipment]  targets:[dbo].[SalesTarget]  EXEC:[dbo].[usp_GenerateInvoice],[dbo].[usp_ApplyDiscount],[audit].[usp_LogChange]
	
	CREATE PROCEDURE [etl].[usp_GenMedium_107]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL

AS
BEGIN
	    SET NOCOUNT ON;
	    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();
	
	    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();


    INSERT INTO dbo.SalesTarget ([SourceID], [SourceName], [LoadedAt])

    SELECT s.[ID], s.[Name], GETUTCDATE()
	    FROM   [fin].[Budget] AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    UPDATE t
    SET    t.[Status]      = s.[Status],
	           t.[UpdatedDate] = GETUTCDATE()
    FROM   dbo.SalesTarget AS t

    JOIN   dbo.Department AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;
	
	    EXEC dbo.usp_GenerateInvoice @ProcessDate = GETDATE(), @BatchID = @BatchID;


    EXEC [dbo].[usp_ApplyDiscount] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC audit.usp_LogChange @ProcessDate = GETDATE(), @BatchID = @BatchID;
	

    -- Reference read: [fin].[Budget]
	    SELECT @RowCount = COUNT(*) FROM fin.Budget WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[Department]
	    SELECT @RowCount = COUNT(*) FROM dbo.Department WHERE [IsDeleted] = 0;
	
    -- Reference read: ops.Shipment
    SELECT @RowCount = COUNT(*) FROM [ops].[Shipment] WHERE [IsDeleted] = 0;

	    SELECT	@RowCount   =  @RowCount + 0;  -- padding stmt


	    RETURN @RowCount;

END

GO