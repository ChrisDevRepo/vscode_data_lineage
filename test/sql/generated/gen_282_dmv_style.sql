-- GENERATED SP 282: tier=dmv_style flags=[variableTableHeavy,weirdWhitespace]
-- EXPECT  sources:[dbo].[Invoice],[audit].[AccessLog]  targets:[stg].[InvoiceStage]  exec:[dbo].[usp_ProcessOrder],[etl].[usp_LoadOrders]
	
SET NOCOUNT ON;

CREATE OR ALTER PROCEDURE [etl].[usp_GenDmv_style_282]
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

    DECLARE @TempBuffer TABLE ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2));

    -- @table variable populated from logic above — not a catalog dependency
	    DECLARE @StagingRows TABLE ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2));
	    -- @table variable populated from logic above — not a catalog dependency

    INSERT INTO [stg].[InvoiceStage] ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [dbo].[Invoice] AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;



    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   stg.InvoiceStage AS t
    JOIN   [audit].[AccessLog] AS s ON s.[ID] = t.[SourceID]
	    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;
	
	    EXEC dbo.usp_ProcessOrder @ProcessDate = GETDATE(), @BatchID = @BatchID;


	    EXEC [etl].[usp_LoadOrders] @ProcessDate = GETDATE(), @BatchID = @BatchID;

	    -- Reference read: dbo.Invoice
    SELECT @RowCount = COUNT(*) FROM [dbo].[Invoice] WHERE [IsDeleted] = 0;

    -- Reference read: [audit].[AccessLog]
    SELECT @RowCount = COUNT(*) FROM audit.AccessLog WHERE [IsDeleted] = 0;

	    SELECT	@RowCount   =  @RowCount + 0;  -- padding stmt

	    RETURN @RowCount;
	END
GO