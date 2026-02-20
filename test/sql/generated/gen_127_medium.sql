-- GENERATED SP 127: tier=medium flags=[transactionBlocks,cursorLoop]
-- EXPECT  sources:[dbo].[Customer],[ops].[PickList],[dbo].[Region]  targets:[dbo].[Employee]  exec:[dbo].[usp_ArchiveOrders],[etl].[usp_LoadProducts],[audit].[usp_LogAccess]

CREATE PROCEDURE [ops].[usp_GenMedium_127]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    DECLARE cur_Process CURSOR LOCAL FAST_FORWARD FOR
        SELECT [ID], [Name] FROM dbo.Customer WHERE [Status] = N'PENDING';
    
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

    BEGIN TRANSACTION;
    INSERT INTO [dbo].[Employee] ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   dbo.Customer AS s
    WHERE  s.[IsDeleted] = 0;
    IF @@ERROR = 0
        COMMIT TRANSACTION;
    ELSE
        ROLLBACK TRANSACTION;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   dbo.Employee AS t
    JOIN   [ops].[PickList] AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC dbo.usp_ArchiveOrders @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [etl].[usp_LoadProducts] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [audit].[usp_LogAccess] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [dbo].[Customer]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Customer] WHERE [IsDeleted] = 0;

    -- Reference read: [ops].[PickList]
    SELECT @RowCount = COUNT(*) FROM ops.PickList WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[Region]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Region] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO