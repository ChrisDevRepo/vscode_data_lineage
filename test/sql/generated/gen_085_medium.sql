-- GENERATED SP 85: tier=medium flags=[deepTryCatch,transactionBlocks]
-- EXPECT  sources:[dbo].[Category],[stg].[InvoiceStage],[stg].[PaymentStage]  targets:[dbo].[Region],[ops].[Shipment]  exec:[dbo].[usp_GenerateInvoice],[dbo].[usp_ArchiveOrders],[dbo].[usp_ReconcilePayments]

CREATE PROCEDURE [hr].[usp_GenMedium_085]
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
            BEGIN TRANSACTION;
            INSERT INTO [dbo].[Region] ([SourceID], [SourceName], [LoadedAt])
            SELECT s.[ID], s.[Name], GETUTCDATE()
            FROM   dbo.Category AS s
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

    BEGIN TRY
        BEGIN TRY
            INSERT INTO ops.Shipment ([SourceID], [RefID], [Amount], [LoadedAt])
            SELECT
                a.[ID]          AS SourceID,
                b.[ID]          AS RefID,
                ISNULL(a.[Amount], 0) AS Amount,
                GETUTCDATE()    AS LoadedAt
            FROM   dbo.Category AS a
            JOIN   stg.InvoiceStage AS c ON c.[ID] = a.[ID]
            JOIN   [stg].[PaymentStage] AS d ON d.[ID] = a.[ID]
            WHERE  a.[Status] = N'PENDING';
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
    FROM   dbo.Region AS t
    JOIN   [stg].[InvoiceStage] AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC [dbo].[usp_GenerateInvoice] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [dbo].[usp_ArchiveOrders] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [dbo].[usp_ReconcilePayments] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: dbo.Category
    SELECT @RowCount = COUNT(*) FROM dbo.Category WHERE [IsDeleted] = 0;

    -- Reference read: stg.InvoiceStage
    SELECT @RowCount = COUNT(*) FROM stg.InvoiceStage WHERE [IsDeleted] = 0;

    -- Reference read: stg.PaymentStage
    SELECT @RowCount = COUNT(*) FROM [stg].[PaymentStage] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO