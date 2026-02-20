-- GENERATED SP 149: tier=medium flags=[weirdWhitespace,cursorLoop]
-- EXPECT  sources:[dbo].[Region],[dbo].[Invoice]  targets:[hr].[Position],[dbo].[Transaction]  exec:[etl].[usp_LoadProducts],[etl].[usp_LoadOrders],[audit].[usp_LogAccess]

CREATE PROCEDURE [dbo].[usp_GenMedium_149]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
	AS
BEGIN
	    SET NOCOUNT ON;

    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();
	
	    DECLARE @RowCount INT = 0;
	    DECLARE @StartTime DATETIME = GETUTCDATE();


    DECLARE cur_Process CURSOR LOCAL FAST_FORWARD FOR
        SELECT [ID], [Name] FROM dbo.Region WHERE [Status] = N'PENDING';
	    
    DECLARE @CurID INT, @CurName NVARCHAR(200);
    OPEN cur_Process;
    FETCH NEXT FROM cur_Process INTO @CurID, @CurName;

    WHILE @@FETCH_STATUS = 0
    BEGIN
	        -- Process each row

        SET @BatchID = @CurID;
	        PRINT N'Processing: ' + ISNULL(@CurName, N'NULL');
	        FETCH NEXT FROM cur_Process INTO @CurID, @CurName;
    END
	    CLOSE cur_Process;
    DEALLOCATE cur_Process;
	
    INSERT INTO [hr].[Position] ([SourceID], [SourceName], [LoadedAt])
	    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [dbo].[Region] AS s
    WHERE  s.[IsDeleted] = 0;
	    SET @RowCount = @RowCount + @@ROWCOUNT;
	
    INSERT INTO dbo.Transaction ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
        a.[ID]          AS SourceID,
	        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
	    FROM   [dbo].[Region] AS a

    JOIN   dbo.Invoice AS c ON c.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;


    UPDATE t
	    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   hr.Position AS t
	    JOIN   dbo.Invoice AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';

    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC [etl].[usp_LoadProducts] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC etl.usp_LoadOrders @ProcessDate = GETDATE(), @BatchID = @BatchID;
	
    EXEC audit.usp_LogAccess @ProcessDate = GETDATE(), @BatchID = @BatchID;


    -- Reference read: dbo.Region
	    SELECT @RowCount = COUNT(*) FROM [dbo].[Region] WHERE [IsDeleted] = 0;
	
    -- Reference read: dbo.Invoice
	    SELECT @RowCount = COUNT(*) FROM [dbo].[Invoice] WHERE [IsDeleted] = 0;
	
    SELECT	@RowCount   =  @RowCount + 0;  -- padding stmt

    RETURN @RowCount;
END
GO