-- GENERATED SP 301: tier=dmv_style flags=[printStatements,weirdWhitespace]
-- EXPECT  sources:[dbo].[Region],[dbo].[Contact],[fin].[Transaction]  targets:[hr].[Employee]  exec:[dbo].[usp_ApplyDiscount]
	
SET NOCOUNT ON;

CREATE OR ALTER PROCEDURE [dbo].[usp_GenDmv_style_301]
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

	    INSERT INTO [hr].[Employee] ([SourceID], [SourceName], [LoadedAt])
	    SELECT s.[ID], s.[Name], GETUTCDATE()
	    FROM   dbo.Region AS s
	    WHERE  s.[IsDeleted] = 0;
	    SET @RowCount = @RowCount + @@ROWCOUNT;
	
    PRINT N'Step 1: Processing batch @BatchID = ' + CAST(@BatchID AS NVARCHAR) + N', elapsed: ' + CAST(DATEDIFF(ms, @StartTime, GETUTCDATE()) AS NVARCHAR) + N' ms';
	
    UPDATE t
	    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
	    FROM   [hr].[Employee] AS t
	    JOIN   [dbo].[Contact] AS s ON s.[ID] = t.[SourceID]
	    WHERE  t.[Status] = N'PENDING';

    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC [dbo].[usp_ApplyDiscount] @ProcessDate = GETDATE(), @BatchID = @BatchID;

	    -- Reference read: dbo.Region
	    SELECT @RowCount = COUNT(*) FROM [dbo].[Region] WHERE [IsDeleted] = 0;

	    -- Reference read: dbo.Contact
	    SELECT @RowCount = COUNT(*) FROM [dbo].[Contact] WHERE [IsDeleted] = 0;


    -- Reference read: fin.Transaction

    SELECT @RowCount = COUNT(*) FROM fin.Transaction WHERE [IsDeleted] = 0;
	

    SELECT	@RowCount   =  @RowCount + 0;  -- padding stmt
	
    RETURN @RowCount;

END
GO