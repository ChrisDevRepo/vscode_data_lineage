-- GENERATED SP 24: tier=tiny flags=[deepTryCatch]
-- EXPECT  sources:[dbo].[Shipper],[stg].[OrderStage]  targets:[rpt].[RegionMetrics]  exec:[etl].[usp_LoadCustomers]

CREATE PROCEDURE [dbo].[usp_GenTiny_024]
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
            INSERT INTO rpt.RegionMetrics ([SourceID], [SourceName], [LoadedAt])
            SELECT s.[ID], s.[Name], GETUTCDATE()
            FROM   dbo.Shipper AS s
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

    EXEC etl.usp_LoadCustomers @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [dbo].[Shipper]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Shipper] WHERE [IsDeleted] = 0;

    -- Reference read: [stg].[OrderStage]
    SELECT @RowCount = COUNT(*) FROM [stg].[OrderStage] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO