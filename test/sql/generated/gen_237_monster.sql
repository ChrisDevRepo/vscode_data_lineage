-- GENERATED SP 237: tier=monster flags=[printStatements,tempTableHeavy,nestedSubqueries,transactionBlocks,excessiveDeclare,deepTryCatch]
-- EXPECT  sources:[stg].[EmployeeStage],[dbo].[OrderLine],[rpt].[MonthlyOrders],[dbo].[Region],[dbo].[Department]  targets:[dbo].[Category],[dbo].[Contact],[etl].[LoadLog],[ops].[ReturnOrder]  exec:[dbo].[usp_UpdateCustomer],[dbo].[usp_ProcessOrder],[dbo].[usp_GenerateInvoice]

CREATE PROCEDURE [hr].[usp_GenMonster_237]
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

    -- Pre-stage data in temp tables
    CREATE TABLE #WorkSet ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2), [ProcessedAt] DATETIME);
    INSERT INTO #WorkSet ([ID], [Name], [Amount], [ProcessedAt])
    SELECT [ID], [Name], ISNULL([Amount], 0), GETUTCDATE()
    FROM   [stg].[EmployeeStage]
    WHERE  [IsDeleted] = 0;
    CREATE TABLE #RefData ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2), [ProcessedAt] DATETIME);
    INSERT INTO #RefData ([ID], [Name], [Amount], [ProcessedAt])
    SELECT [ID], [Name], ISNULL([Amount], 0), GETUTCDATE()
    FROM   [dbo].[OrderLine]
    WHERE  [IsDeleted] = 0;

    BEGIN TRY
        BEGIN TRY
            BEGIN TRY
                BEGIN TRANSACTION;
                INSERT INTO dbo.Category ([ID], [Name])
                SELECT x.[ID], x.[Name]
                FROM (
                    SELECT i.[ID], i.[Name], ROW_NUMBER() OVER (ORDER BY i.[UpdatedDate] DESC) AS rn
                    FROM (
                        SELECT [ID], [Name], [UpdatedDate]
                        FROM   stg.EmployeeStage
                        WHERE  [IsDeleted] = 0
                    ) AS i
                ) AS x
                WHERE x.rn = 1;
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
                INSERT INTO dbo.Contact ([SourceID], [RefID], [Amount], [LoadedAt])
                SELECT
                    a.[ID]          AS SourceID,
                    b.[ID]          AS RefID,
                    ISNULL(a.[Amount], 0) AS Amount,
                    GETUTCDATE()    AS LoadedAt
                FROM   stg.EmployeeStage AS a
                JOIN   [dbo].[OrderLine] AS c ON c.[ID] = a.[ID]
                JOIN   rpt.MonthlyOrders AS d ON d.[ID] = a.[ID]
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
                INSERT INTO [etl].[LoadLog] ([SourceID], [RefID], [Amount], [LoadedAt])
                SELECT
                    a.[ID]          AS SourceID,
                    b.[ID]          AS RefID,
                    ISNULL(a.[Amount], 0) AS Amount,
                    GETUTCDATE()    AS LoadedAt
                FROM   stg.EmployeeStage AS a
                JOIN   [dbo].[OrderLine] AS c ON c.[ID] = a.[ID]
                JOIN   [rpt].[MonthlyOrders] AS d ON d.[ID] = a.[ID]
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

    BEGIN TRY
        BEGIN TRY
            BEGIN TRY
                INSERT INTO [ops].[ReturnOrder] ([SourceID], [RefID], [Amount], [LoadedAt])
                SELECT
                    a.[ID]          AS SourceID,
                    b.[ID]          AS RefID,
                    ISNULL(a.[Amount], 0) AS Amount,
                    GETUTCDATE()    AS LoadedAt
                FROM   [stg].[EmployeeStage] AS a
                JOIN   [dbo].[OrderLine] AS c ON c.[ID] = a.[ID]
                JOIN   rpt.MonthlyOrders AS d ON d.[ID] = a.[ID]
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

    PRINT N'Step 4: Processing batch @BatchID = ' + CAST(@BatchID AS NVARCHAR) + N', elapsed: ' + CAST(DATEDIFF(ms, @StartTime, GETUTCDATE()) AS NVARCHAR) + N' ms';

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   [dbo].[Category] AS t
    JOIN   [dbo].[OrderLine] AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    MERGE INTO ops.ReturnOrder AS tgt
    USING dbo.Department AS src ON src.[ID] = tgt.[ID]
    WHEN MATCHED THEN
        UPDATE SET tgt.[Name] = src.[Name], tgt.[UpdatedDate] = GETUTCDATE()
    WHEN NOT MATCHED BY TARGET THEN
        INSERT ([ID], [Name], [CreatedDate]) VALUES (src.[ID], src.[Name], GETUTCDATE())
    WHEN NOT MATCHED BY SOURCE THEN
        UPDATE SET tgt.[IsDeleted] = 1;

    EXEC [dbo].[usp_UpdateCustomer] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC dbo.usp_ProcessOrder @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [dbo].[usp_GenerateInvoice] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: stg.EmployeeStage
    SELECT @RowCount = COUNT(*) FROM [stg].[EmployeeStage] WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[OrderLine]
    SELECT @RowCount = COUNT(*) FROM [dbo].[OrderLine] WHERE [IsDeleted] = 0;

    -- Reference read: rpt.MonthlyOrders
    SELECT @RowCount = COUNT(*) FROM rpt.MonthlyOrders WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[Region]
    SELECT @RowCount = COUNT(*) FROM dbo.Region WHERE [IsDeleted] = 0;

    -- Reference read: dbo.Department
    SELECT @RowCount = COUNT(*) FROM [dbo].[Department] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO