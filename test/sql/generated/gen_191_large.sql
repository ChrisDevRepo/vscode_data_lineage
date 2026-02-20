-- GENERATED SP 191: tier=large flags=[printStatements,deepTryCatch,noBrackets]
-- EXPECT  sources:[fin].[CostCenter],[dbo].[Address],[dbo].[Region],[dbo].[Employee],[ops].[ReturnOrder],[stg].[EmployeeStage]  targets:[fin].[Transaction],[stg].[PaymentStage]  exec:[hr].[usp_ApproveLeave],[etl].[usp_LoadCustomers],[dbo].[usp_UpdateCustomer],[dbo].[usp_ReconcilePayments],[etl].[usp_LoadProducts],[dbo].[usp_ArchiveOrders]

CREATE PROCEDURE [dbo].[usp_GenLarge_191]
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
            INSERT INTO fin.Transaction ([SourceID], [SourceName], [LoadedAt])
            SELECT s.[ID], s.[Name], GETUTCDATE()
            FROM   fin.CostCenter AS s
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

    PRINT N'Step 1: Processing batch @BatchID = ' + CAST(@BatchID AS NVARCHAR) + N', elapsed: ' + CAST(DATEDIFF(ms, @StartTime, GETUTCDATE()) AS NVARCHAR) + N' ms';

    BEGIN TRY
        BEGIN TRY
            INSERT INTO stg.PaymentStage ([SourceID], [RefID], [Amount], [LoadedAt])
            SELECT
                a.[ID]          AS SourceID,
                b.[ID]          AS RefID,
                ISNULL(a.[Amount], 0) AS Amount,
                GETUTCDATE()    AS LoadedAt
            FROM   fin.CostCenter AS a
            JOIN   dbo.Address AS c ON c.[ID] = a.[ID]
            JOIN   dbo.Region AS d ON d.[ID] = a.[ID]
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

    PRINT N'Step 2: Processing batch @BatchID = ' + CAST(@BatchID AS NVARCHAR) + N', elapsed: ' + CAST(DATEDIFF(ms, @StartTime, GETUTCDATE()) AS NVARCHAR) + N' ms';

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   fin.Transaction AS t
    JOIN   dbo.Address AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    MERGE INTO stg.PaymentStage AS tgt
    USING stg.EmployeeStage AS src ON src.[ID] = tgt.[ID]
    WHEN MATCHED THEN
        UPDATE SET tgt.[Name] = src.[Name], tgt.[UpdatedDate] = GETUTCDATE()
    WHEN NOT MATCHED BY TARGET THEN
        INSERT ([ID], [Name], [CreatedDate]) VALUES (src.[ID], src.[Name], GETUTCDATE())
    WHEN NOT MATCHED BY SOURCE THEN
        UPDATE SET tgt.[IsDeleted] = 1;

    EXEC hr.usp_ApproveLeave @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC etl.usp_LoadCustomers @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC dbo.usp_UpdateCustomer @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC dbo.usp_ReconcilePayments @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC etl.usp_LoadProducts @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC dbo.usp_ArchiveOrders @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: fin.CostCenter
    SELECT @RowCount = COUNT(*) FROM fin.CostCenter WHERE [IsDeleted] = 0;

    -- Reference read: dbo.Address
    SELECT @RowCount = COUNT(*) FROM dbo.Address WHERE [IsDeleted] = 0;

    -- Reference read: dbo.Region
    SELECT @RowCount = COUNT(*) FROM dbo.Region WHERE [IsDeleted] = 0;

    -- Reference read: dbo.Employee
    SELECT @RowCount = COUNT(*) FROM dbo.Employee WHERE [IsDeleted] = 0;

    -- Reference read: ops.ReturnOrder
    SELECT @RowCount = COUNT(*) FROM ops.ReturnOrder WHERE [IsDeleted] = 0;

    -- Reference read: stg.EmployeeStage
    SELECT @RowCount = COUNT(*) FROM stg.EmployeeStage WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO