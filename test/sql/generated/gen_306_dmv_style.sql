-- GENERATED SP 306: tier=dmv_style flags=[deepTryCatch,transactionBlocks]
-- EXPECT  sources:[dbo].[Invoice],[etl].[ErrorLog]  targets:[dbo].[Order]  exec:[fin].[usp_PostJournal]

SET NOCOUNT ON;

CREATE OR ALTER PROCEDURE [rpt].[usp_GenDmv_style_306]
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

    BEGIN TRY
        BEGIN TRY
            BEGIN TRANSACTION;
            INSERT INTO dbo.Order ([SourceID], [SourceName], [LoadedAt])
            SELECT s.[ID], s.[Name], GETUTCDATE()
            FROM   dbo.Invoice AS s
            WHERE  s.[IsDeleted] = 0;
            IF @@ERROR = 0
                COMMIT TRANSACTION;
            ELSE
                ROLLBACK TRANSACTION;
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
    FROM   [dbo].[Order] AS t
    JOIN   etl.ErrorLog AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC [fin].[usp_PostJournal] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: dbo.Invoice
    SELECT @RowCount = COUNT(*) FROM [dbo].[Invoice] WHERE [IsDeleted] = 0;

    -- Reference read: [etl].[ErrorLog]
    SELECT @RowCount = COUNT(*) FROM etl.ErrorLog WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO