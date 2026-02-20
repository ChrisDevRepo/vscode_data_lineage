-- GENERATED SP 119: tier=medium flags=[variableTableHeavy,deepTryCatch]
-- EXPECT  sources:[rpt].[RegionMetrics],[dbo].[Region]  targets:[etl].[ErrorLog]  exec:[dbo].[usp_UpdateCustomer],[audit].[usp_LogAccess],[dbo].[usp_GenerateInvoice]

CREATE PROCEDURE [rpt].[usp_GenMedium_119]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    DECLARE @TempBuffer TABLE ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2));
    -- @table variable populated from logic above — not a catalog dependency
    DECLARE @StagingRows TABLE ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2));
    -- @table variable populated from logic above — not a catalog dependency

    BEGIN TRY
        BEGIN TRY
            INSERT INTO etl.ErrorLog ([SourceID], [SourceName], [LoadedAt])
            SELECT s.[ID], s.[Name], GETUTCDATE()
            FROM   rpt.RegionMetrics AS s
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
    FROM   [etl].[ErrorLog] AS t
    JOIN   [dbo].[Region] AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC dbo.usp_UpdateCustomer @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC audit.usp_LogAccess @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [dbo].[usp_GenerateInvoice] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [rpt].[RegionMetrics]
    SELECT @RowCount = COUNT(*) FROM [rpt].[RegionMetrics] WHERE [IsDeleted] = 0;

    -- Reference read: dbo.Region
    SELECT @RowCount = COUNT(*) FROM dbo.Region WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO