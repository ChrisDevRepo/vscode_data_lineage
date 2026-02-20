-- GENERATED SP 142: tier=medium flags=[deepTryCatch,variableTableHeavy]
-- EXPECT  sources:[ops].[Inventory],[fin].[Account],[dbo].[Warehouse],[hr].[Performance]  targets:[dbo].[Customer]  exec:[etl].[usp_LoadCustomers],[dbo].[usp_UpdateCustomer],[dbo].[usp_ProcessOrder]

CREATE PROCEDURE [rpt].[usp_GenMedium_142]
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
            INSERT INTO [dbo].[Customer] ([SourceID], [SourceName], [LoadedAt])
            SELECT s.[ID], s.[Name], GETUTCDATE()
            FROM   [ops].[Inventory] AS s
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
    FROM   [dbo].[Customer] AS t
    JOIN   [fin].[Account] AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC etl.usp_LoadCustomers @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC dbo.usp_UpdateCustomer @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [dbo].[usp_ProcessOrder] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [ops].[Inventory]
    SELECT @RowCount = COUNT(*) FROM ops.Inventory WHERE [IsDeleted] = 0;

    -- Reference read: [fin].[Account]
    SELECT @RowCount = COUNT(*) FROM [fin].[Account] WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[Warehouse]
    SELECT @RowCount = COUNT(*) FROM dbo.Warehouse WHERE [IsDeleted] = 0;

    -- Reference read: hr.Performance
    SELECT @RowCount = COUNT(*) FROM [hr].[Performance] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO