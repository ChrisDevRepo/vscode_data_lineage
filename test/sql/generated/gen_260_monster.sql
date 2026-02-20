-- GENERATED SP 260: tier=monster flags=[allCaps,nestedSubqueries,cursorLoop,commentedOutSQL,excessiveDeclare,deepTryCatch]
-- EXPECT  sources:[fin].[Budget],[stg].[EmployeeStage],[audit].[ChangeLog],[rpt].[CustomerChurn],[hr].[Performance],[dbo].[SalesTarget],[dbo].[PriceList],[hr].[LeaveRequest]  targets:[dbo].[Employee],[rpt].[ProductRevenue],[stg].[PaymentStage],[dbo].[Department]  EXEC:[dbo].[usp_ApplyDiscount],[dbo].[usp_ProcessOrder],[etl].[usp_LoadCustomers],[fin].[usp_PostJournal],[etl].[usp_LoadOrders],[hr].[usp_ApproveLeave]

CREATE PROCEDURE [etl].[usp_GenMonster_260]
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

    DECLARE cur_Process CURSOR LOCAL FAST_FORWARD FOR
        SELECT [ID], [Name] FROM [fin].[Budget] WHERE [Status] = N'PENDING';
    
    DECLARE @CurID INT, @CurName NVARCHAR(200);
    OPEN cur_Process;
    FETCH NEXT FROM cur_Process INTO @CurID, @CurName;
    WHILE @@FETCH_STATUS = 0
    BEGIN
        -- Process each row
        SET @BatchID = @CurID;
        PRINT N'Processing: ' + ISNULL(@CurName, N'NULL');
        FETCH NEXT FROM cur_Process INTO @CurID, @CurName;
    END
    CLOSE cur_Process;
    DEALLOCATE cur_Process;

    BEGIN TRY
        BEGIN TRY
            BEGIN TRY
                INSERT INTO [dbo].[Employee] ([ID], [Name])
                SELECT x.[ID], x.[Name]
                FROM (
                    SELECT i.[ID], i.[Name], ROW_NUMBER() OVER (ORDER BY i.[UpdatedDate] DESC) AS rn
                    FROM (
                        SELECT [ID], [Name], [UpdatedDate]
                        FROM   fin.Budget
                        WHERE  [IsDeleted] = 0
                    ) AS i
                ) AS x
                WHERE x.rn = 1;
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

    BEGIN TRY
        BEGIN TRY
            BEGIN TRY
                INSERT INTO rpt.ProductRevenue ([SourceID], [RefID], [Amount], [LoadedAt])
                SELECT
                    a.[ID]          AS SourceID,
                    b.[ID]          AS RefID,
                    ISNULL(a.[Amount], 0) AS Amount,
                    GETUTCDATE()    AS LoadedAt
                FROM   fin.Budget AS a
                JOIN   [stg].[EmployeeStage] AS c ON c.[ID] = a.[ID]
                JOIN   [audit].[ChangeLog] AS d ON d.[ID] = a.[ID]
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

    BEGIN TRY
        BEGIN TRY
            BEGIN TRY
                INSERT INTO [stg].[PaymentStage] ([SourceID], [RefID], [Amount], [LoadedAt])
                SELECT
                    a.[ID]          AS SourceID,
                    b.[ID]          AS RefID,
                    ISNULL(a.[Amount], 0) AS Amount,
                    GETUTCDATE()    AS LoadedAt
                FROM   fin.Budget AS a
                JOIN   [stg].[EmployeeStage] AS c ON c.[ID] = a.[ID]
                JOIN   [audit].[ChangeLog] AS d ON d.[ID] = a.[ID]
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

    BEGIN TRY
        BEGIN TRY
            BEGIN TRY
                INSERT INTO [dbo].[Department] ([SourceID], [RefID], [Amount], [LoadedAt])
                SELECT
                    a.[ID]          AS SourceID,
                    b.[ID]          AS RefID,
                    ISNULL(a.[Amount], 0) AS Amount,
                    GETUTCDATE()    AS LoadedAt
                FROM   fin.Budget AS a
                JOIN   stg.EmployeeStage AS c ON c.[ID] = a.[ID]
                JOIN   audit.ChangeLog AS d ON d.[ID] = a.[ID]
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

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   dbo.Employee AS t
    JOIN   [stg].[EmployeeStage] AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    MERGE INTO [dbo].[Department] AS tgt
    USING hr.LeaveRequest AS src ON src.[ID] = tgt.[ID]
    WHEN MATCHED THEN
        UPDATE SET tgt.[Name] = src.[Name], tgt.[UpdatedDate] = GETUTCDATE()
    WHEN NOT MATCHED BY TARGET THEN
        INSERT ([ID], [Name], [CreatedDate]) VALUES (src.[ID], src.[Name], GETUTCDATE())
    WHEN NOT MATCHED BY SOURCE THEN
        UPDATE SET tgt.[IsDeleted] = 1;

    EXEC dbo.usp_ApplyDiscount @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC dbo.usp_ProcessOrder @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC etl.usp_LoadCustomers @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC fin.usp_PostJournal @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC etl.usp_LoadOrders @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC hr.usp_ApproveLeave @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [fin].[Budget]
    SELECT @RowCount = COUNT(*) FROM [fin].[Budget] WHERE [IsDeleted] = 0;

    -- Reference read: stg.EmployeeStage
    SELECT @RowCount = COUNT(*) FROM stg.EmployeeStage WHERE [IsDeleted] = 0;

    -- Reference read: [audit].[ChangeLog]
    SELECT @RowCount = COUNT(*) FROM [audit].[ChangeLog] WHERE [IsDeleted] = 0;

    -- Reference read: [rpt].[CustomerChurn]
    SELECT @RowCount = COUNT(*) FROM [rpt].[CustomerChurn] WHERE [IsDeleted] = 0;

    -- Reference read: [hr].[Performance]
    SELECT @RowCount = COUNT(*) FROM [hr].[Performance] WHERE [IsDeleted] = 0;

    -- Reference read: dbo.SalesTarget
    SELECT @RowCount = COUNT(*) FROM [dbo].[SalesTarget] WHERE [IsDeleted] = 0;

    -- Reference read: dbo.PriceList
    SELECT @RowCount = COUNT(*) FROM dbo.PriceList WHERE [IsDeleted] = 0;

    -- Reference read: hr.LeaveRequest
    SELECT @RowCount = COUNT(*) FROM [hr].[LeaveRequest] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO