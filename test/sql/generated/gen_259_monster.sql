-- GENERATED SP 259: tier=monster flags=[deepTryCatch,printStatements,noBrackets,commentedOutSQL,transactionBlocks,excessiveDeclare]
-- EXPECT  sources:[dbo].[SalesTarget],[stg].[OrderStage],[dbo].[Category],[dbo].[Address],[ops].[Inventory],[stg].[InvoiceStage],[ops].[PickList]  targets:[rpt].[EmployeePerf],[dbo].[Employee],[dbo].[Transaction]  exec:[etl].[usp_LoadProducts],[audit].[usp_LogChange],[dbo].[usp_ApplyDiscount],[hr].[usp_ApproveLeave],[dbo].[usp_ProcessOrder],[dbo].[usp_UpdateCustomer]

CREATE PROCEDURE [etl].[usp_GenMonster_259]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @BatchID INT = 0;
    DECLARE @ProcessDate DATETIME = GETDATE();
    DECLARE @RowCount INT;
    DECLARE @ErrorMessage NVARCHAR(4000);
    DECLARE @ErrorSeverity INT;
    DECLARE @ErrorState INT;
    DECLARE @RetryCount INT = 0;
    DECLARE @MaxRetries INT = 3;
    DECLARE @StartTime DATETIME = GETUTCDATE();
    DECLARE @EndTime DATETIME;
    DECLARE @DebugMode BIT = 0;
    DECLARE @SchemaVersion NVARCHAR(20) = N'1.0';
    DECLARE @ProcName NVARCHAR(128) = OBJECT_NAME(@@PROCID);
    DECLARE @AppName NVARCHAR(128) = APP_NAME();
    DECLARE @HostName NVARCHAR(128) = HOST_NAME();
    DECLARE @UserName NVARCHAR(128) = SUSER_SNAME();
    DECLARE @DBName NVARCHAR(128) = DB_NAME();
    DECLARE @ServerName NVARCHAR(128) = @@SERVERNAME;
    DECLARE @SPID INT = @@SPID;
    DECLARE @NestLevel INT = @@NESTLEVEL;

    -- OLD CODE (removed 2019-06-15) — kept for reference:
    -- INSERT INTO dbo.DeprecatedLog (EntityID, Action, LogDate)
    -- SELECT ID, N'PROCESS', GETDATE() FROM dbo.OldLegacyTable WHERE Status = 0
    -- UPDATE dbo.OldFlag SET Active = 0 WHERE ProcessDate < '2019-01-01'
    -- EXEC dbo.usp_OldArchive @cutoff = '2019-01-01'

    BEGIN TRY
        BEGIN TRY
            BEGIN TRY
                BEGIN TRANSACTION;
                INSERT INTO rpt.EmployeePerf ([SourceID], [SourceName], [LoadedAt])
                SELECT s.[ID], s.[Name], GETUTCDATE()
                FROM   dbo.SalesTarget AS s
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
            BEGIN TRY
                INSERT INTO dbo.Employee ([SourceID], [RefID], [Amount], [LoadedAt])
                SELECT
                    a.[ID]          AS SourceID,
                    b.[ID]          AS RefID,
                    ISNULL(a.[Amount], 0) AS Amount,
                    GETUTCDATE()    AS LoadedAt
                FROM   dbo.SalesTarget AS a
                JOIN   stg.OrderStage AS c ON c.[ID] = a.[ID]
                JOIN   dbo.Category AS d ON d.[ID] = a.[ID]
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
    END TRY
    BEGIN CATCH
        SET @ErrorMessage = ERROR_MESSAGE();
        SET @ErrorSeverity = ERROR_SEVERITY();
        SET @ErrorState = ERROR_STATE();
        RAISERROR(@ErrorMessage, @ErrorSeverity, @ErrorState);
    END CATCH
    SET @RowCount = @RowCount + @@ROWCOUNT;

    PRINT N'Step 2: Processing batch @BatchID = ' + CAST(@BatchID AS NVARCHAR) + N', elapsed: ' + CAST(DATEDIFF(ms, @StartTime, GETUTCDATE()) AS NVARCHAR) + N' ms';

    BEGIN TRY
        BEGIN TRY
            BEGIN TRY
                INSERT INTO dbo.Transaction ([SourceID], [RefID], [Amount], [LoadedAt])
                SELECT
                    a.[ID]          AS SourceID,
                    b.[ID]          AS RefID,
                    ISNULL(a.[Amount], 0) AS Amount,
                    GETUTCDATE()    AS LoadedAt
                FROM   dbo.SalesTarget AS a
                JOIN   stg.OrderStage AS c ON c.[ID] = a.[ID]
                JOIN   dbo.Category AS d ON d.[ID] = a.[ID]
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
    END TRY
    BEGIN CATCH
        SET @ErrorMessage = ERROR_MESSAGE();
        SET @ErrorSeverity = ERROR_SEVERITY();
        SET @ErrorState = ERROR_STATE();
        RAISERROR(@ErrorMessage, @ErrorSeverity, @ErrorState);
    END CATCH
    SET @RowCount = @RowCount + @@ROWCOUNT;

    PRINT N'Step 3: Processing batch @BatchID = ' + CAST(@BatchID AS NVARCHAR) + N', elapsed: ' + CAST(DATEDIFF(ms, @StartTime, GETUTCDATE()) AS NVARCHAR) + N' ms';

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   rpt.EmployeePerf AS t
    JOIN   stg.OrderStage AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    MERGE INTO dbo.Transaction AS tgt
    USING ops.PickList AS src ON src.[ID] = tgt.[ID]
    WHEN MATCHED THEN
        UPDATE SET tgt.[Name] = src.[Name], tgt.[UpdatedDate] = GETUTCDATE()
    WHEN NOT MATCHED BY TARGET THEN
        INSERT ([ID], [Name], [CreatedDate]) VALUES (src.[ID], src.[Name], GETUTCDATE())
    WHEN NOT MATCHED BY SOURCE THEN
        UPDATE SET tgt.[IsDeleted] = 1;

    EXEC etl.usp_LoadProducts @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC audit.usp_LogChange @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC dbo.usp_ApplyDiscount @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC hr.usp_ApproveLeave @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC dbo.usp_ProcessOrder @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC dbo.usp_UpdateCustomer @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: dbo.SalesTarget
    SELECT @RowCount = COUNT(*) FROM dbo.SalesTarget WHERE [IsDeleted] = 0;

    -- Reference read: stg.OrderStage
    SELECT @RowCount = COUNT(*) FROM stg.OrderStage WHERE [IsDeleted] = 0;

    -- Reference read: dbo.Category
    SELECT @RowCount = COUNT(*) FROM dbo.Category WHERE [IsDeleted] = 0;

    -- Reference read: dbo.Address
    SELECT @RowCount = COUNT(*) FROM dbo.Address WHERE [IsDeleted] = 0;

    -- Reference read: ops.Inventory
    SELECT @RowCount = COUNT(*) FROM ops.Inventory WHERE [IsDeleted] = 0;

    -- Reference read: stg.InvoiceStage
    SELECT @RowCount = COUNT(*) FROM stg.InvoiceStage WHERE [IsDeleted] = 0;

    -- Reference read: ops.PickList
    SELECT @RowCount = COUNT(*) FROM ops.PickList WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO