-- GENERATED SP 93: tier=medium flags=[weirdWhitespace,allCaps]
-- EXPECT  sources:[stg].[InvoiceStage],[dbo].[Contact]  targets:[hr].[Performance]  EXEC:[dbo].[usp_UpdateCustomer]



CREATE PROCEDURE [hr].[usp_GenMedium_093]
    @BatchID    INT = 0,
	    @ProcessDate DATETIME = NULL
AS
	BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();


    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    INSERT INTO hr.Performance ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   stg.InvoiceStage AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

	    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   [hr].[Performance] AS t
    JOIN   dbo.Contact AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC [dbo].[usp_UpdateCustomer] @ProcessDate = GETDATE(), @BatchID = @BatchID;


    -- Reference read: stg.InvoiceStage
	    SELECT @RowCount = COUNT(*) FROM [stg].[InvoiceStage] WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[Contact]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Contact] WHERE [IsDeleted] = 0;



    SELECT	@RowCount   =  @RowCount + 0;  -- padding stmt

	    RETURN @RowCount;
END
GO