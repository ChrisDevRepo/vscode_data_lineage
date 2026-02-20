-- GENERATED SP 49: tier=tiny flags=[deepTryCatch]
-- EXPECT  sources:[dbo].[Category],[dbo].[Order]  targets:[stg].[PaymentStage]  exec:[dbo].[usp_ReconcilePayments]

CREATE PROCEDURE [hr].[usp_GenTiny_049]
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
            INSERT INTO stg.PaymentStage ([SourceID], [SourceName], [LoadedAt])
            SELECT s.[ID], s.[Name], GETUTCDATE()
            FROM   dbo.Category AS s
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

    EXEC [dbo].[usp_ReconcilePayments] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [dbo].[Category]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Category] WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[Order]
    SELECT @RowCount = COUNT(*) FROM dbo.Order WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO