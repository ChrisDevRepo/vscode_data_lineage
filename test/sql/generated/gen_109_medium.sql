-- GENERATED SP 109: tier=medium flags=[weirdWhitespace,allCaps]
-- EXPECT  sources:[dbo].[Shipper],[stg].[InvoiceStage],[dbo].[Order]  targets:[dbo].[Customer],[dbo].[PriceList]  EXEC:[audit].[usp_LogChange],[etl].[usp_LoadProducts],[etl].[usp_ValidateStage]

	CREATE PROCEDURE [rpt].[usp_GenMedium_109]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();


    DECLARE @RowCount INT = 0;
	    DECLARE @StartTime DATETIME = GETUTCDATE();

    INSERT INTO dbo.Customer ([SourceID], [SourceName], [LoadedAt])
	    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [dbo].[Shipper] AS s

    WHERE  s.[IsDeleted] = 0;
	    SET @RowCount = @RowCount + @@ROWCOUNT;

	    INSERT INTO dbo.PriceList ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
	        a.[ID]          AS SourceID,
	        b.[ID]          AS RefID,
	        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt

    FROM   [dbo].[Shipper] AS a

    JOIN   [stg].[InvoiceStage] AS c ON c.[ID] = a.[ID]
    JOIN   dbo.Order AS d ON d.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;
	
    UPDATE t
    SET    t.[Status]      = s.[Status],
	           t.[UpdatedDate] = GETUTCDATE()
	    FROM   dbo.Customer AS t
    JOIN   [stg].[InvoiceStage] AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
	    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC [audit].[usp_LogChange] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [etl].[usp_LoadProducts] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC etl.usp_ValidateStage @ProcessDate = GETDATE(), @BatchID = @BatchID;


    -- Reference read: [dbo].[Shipper]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Shipper] WHERE [IsDeleted] = 0;



    -- Reference read: [stg].[InvoiceStage]
	    SELECT @RowCount = COUNT(*) FROM [stg].[InvoiceStage] WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[Order]
    SELECT @RowCount = COUNT(*) FROM dbo.Order WHERE [IsDeleted] = 0;

    SELECT	@RowCount   =  @RowCount + 0;  -- padding stmt
	
	    RETURN @RowCount;
	END

GO