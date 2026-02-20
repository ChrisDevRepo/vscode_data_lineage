-- GENERATED SP 58: tier=medium flags=[commentedOutSQL,cursorLoop]
-- EXPECT  sources:[dbo].[Product],[dbo].[OrderLine],[dbo].[Warehouse],[etl].[BatchControl]  targets:[stg].[EmployeeStage]  exec:[etl].[usp_LoadProducts]

CREATE PROCEDURE [dbo].[usp_GenMedium_058]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    -- OLD CODE (removed 2019-06-15) — kept for reference:
    -- INSERT INTO dbo.DeprecatedLog (EntityID, Action, LogDate)
    -- SELECT ID, N'PROCESS', GETDATE() FROM dbo.OldLegacyTable WHERE Status = 0
    -- UPDATE dbo.OldFlag SET Active = 0 WHERE ProcessDate < '2019-01-01'
    -- EXEC dbo.usp_OldArchive @cutoff = '2019-01-01'

    DECLARE cur_Process CURSOR LOCAL FAST_FORWARD FOR
        SELECT [ID], [Name] FROM dbo.Product WHERE [Status] = N'PENDING';
    
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

    INSERT INTO [stg].[EmployeeStage] ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [dbo].[Product] AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   [stg].[EmployeeStage] AS t
    JOIN   [dbo].[OrderLine] AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC [etl].[usp_LoadProducts] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: dbo.Product
    SELECT @RowCount = COUNT(*) FROM dbo.Product WHERE [IsDeleted] = 0;

    -- Reference read: dbo.OrderLine
    SELECT @RowCount = COUNT(*) FROM dbo.OrderLine WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[Warehouse]
    SELECT @RowCount = COUNT(*) FROM dbo.Warehouse WHERE [IsDeleted] = 0;

    -- Reference read: [etl].[BatchControl]
    SELECT @RowCount = COUNT(*) FROM etl.BatchControl WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO