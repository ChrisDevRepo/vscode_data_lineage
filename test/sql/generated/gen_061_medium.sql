-- GENERATED SP 61: tier=medium flags=[deepTryCatch,cursorLoop]
-- EXPECT  sources:[etl].[ExtractLog],[rpt].[EmployeePerf],[etl].[ErrorLog]  targets:[dbo].[Address]  exec:[etl].[usp_LoadOrders],[dbo].[usp_ArchiveOrders],[dbo].[usp_GenerateInvoice]

CREATE PROCEDURE [rpt].[usp_GenMedium_061]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    DECLARE cur_Process CURSOR LOCAL FAST_FORWARD FOR
        SELECT [ID], [Name] FROM [etl].[ExtractLog] WHERE [Status] = N'PENDING';
    
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

    BEGIN TRY
        BEGIN TRY
            INSERT INTO dbo.Address ([SourceID], [SourceName], [LoadedAt])
            SELECT s.[ID], s.[Name], GETUTCDATE()
            FROM   [etl].[ExtractLog] AS s
            WHERE  s.[IsDeleted] = 0;
        END TRY
        BEGIN CATCH
            SET @ErrorMessage = ERROR_MESSAGE();
            SET @ErrorSeverity = ERROR_SEVERITY();
            SET @ErrorState = ERROR_STATE();
            RAISERROR(@ErrorMessage, @ErrorSeverity, @ErrorState);
        END CATCH
    END TRY
    BEGIN CATCH
        SET @ErrorMessage = ERROR_MESSAGE();
        SET @ErrorSeverity = ERROR_SEVERITY();
        SET @ErrorState = ERROR_STATE();
        RAISERROR(@ErrorMessage, @ErrorSeverity, @ErrorState);
    END CATCH
    SET @RowCount = @RowCount + @@ROWCOUNT;

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   [dbo].[Address] AS t
    JOIN   rpt.EmployeePerf AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC etl.usp_LoadOrders @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC dbo.usp_ArchiveOrders @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC dbo.usp_GenerateInvoice @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: etl.ExtractLog
    SELECT @RowCount = COUNT(*) FROM [etl].[ExtractLog] WHERE [IsDeleted] = 0;

    -- Reference read: [rpt].[EmployeePerf]
    SELECT @RowCount = COUNT(*) FROM rpt.EmployeePerf WHERE [IsDeleted] = 0;

    -- Reference read: [etl].[ErrorLog]
    SELECT @RowCount = COUNT(*) FROM [etl].[ErrorLog] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO