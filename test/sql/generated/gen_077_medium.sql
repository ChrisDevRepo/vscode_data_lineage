-- GENERATED SP 77: tier=medium flags=[bracketedEverything,deepTryCatch]
-- EXPECT  sources:[dbo].[Customer],[fin].[Budget],[etl].[LoadLog],[dbo].[Warehouse]  targets:[dbo].[Product]  exec:[etl].[usp_ValidateStage]

CREATE PROCEDURE [hr].[usp_GenMedium_077]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    BEGIN TRY
        BEGIN TRY
            INSERT INTO [dbo].[Product] ([SourceID], [SourceName], [LoadedAt])
            SELECT s.[ID], s.[Name], GETUTCDATE()
            FROM   [dbo].[Customer] AS s
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
    FROM   [dbo].[Product] AS t
    JOIN   [fin].[Budget] AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC [etl].[usp_ValidateStage] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [dbo].[Customer]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Customer] WHERE [IsDeleted] = 0;

    -- Reference read: [fin].[Budget]
    SELECT @RowCount = COUNT(*) FROM [fin].[Budget] WHERE [IsDeleted] = 0;

    -- Reference read: [etl].[LoadLog]
    SELECT @RowCount = COUNT(*) FROM [etl].[LoadLog] WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[Warehouse]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Warehouse] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO