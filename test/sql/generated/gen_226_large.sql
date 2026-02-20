-- GENERATED SP 226: tier=large flags=[deepTryCatch,excessiveDeclare,nestedSubqueries]
-- EXPECT  sources:[stg].[EmployeeStage],[dbo].[Account],[dbo].[Category],[fin].[Budget],[stg].[OrderStage]  targets:[dbo].[OrderLine],[dbo].[Invoice]  exec:[dbo].[usp_UpdateCustomer],[audit].[usp_LogChange],[etl].[usp_LoadCustomers]

CREATE PROCEDURE [dbo].[usp_GenLarge_226]
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

    BEGIN TRY
        BEGIN TRY
            INSERT INTO dbo.OrderLine ([ID], [Name])
            SELECT x.[ID], x.[Name]
            FROM (
                SELECT i.[ID], i.[Name], ROW_NUMBER() OVER (ORDER BY i.[UpdatedDate] DESC) AS rn
                FROM (
                    SELECT [ID], [Name], [UpdatedDate]
                    FROM   [stg].[EmployeeStage]
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
    SET @RowCount = @RowCount + @@ROWCOUNT;

    BEGIN TRY
        BEGIN TRY
            INSERT INTO dbo.Invoice ([SourceID], [RefID], [Amount], [LoadedAt])
            SELECT
                a.[ID]          AS SourceID,
                b.[ID]          AS RefID,
                ISNULL(a.[Amount], 0) AS Amount,
                GETUTCDATE()    AS LoadedAt
            FROM   [stg].[EmployeeStage] AS a
            JOIN   [dbo].[Account] AS c ON c.[ID] = a.[ID]
            JOIN   [dbo].[Category] AS d ON d.[ID] = a.[ID]
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
    FROM   [dbo].[OrderLine] AS t
    JOIN   dbo.Account AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    MERGE INTO [dbo].[Invoice] AS tgt
    USING [stg].[OrderStage] AS src ON src.[ID] = tgt.[ID]
    WHEN MATCHED THEN
        UPDATE SET tgt.[Name] = src.[Name], tgt.[UpdatedDate] = GETUTCDATE()
    WHEN NOT MATCHED BY TARGET THEN
        INSERT ([ID], [Name], [CreatedDate]) VALUES (src.[ID], src.[Name], GETUTCDATE())
    WHEN NOT MATCHED BY SOURCE THEN
        UPDATE SET tgt.[IsDeleted] = 1;

    EXEC dbo.usp_UpdateCustomer @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [audit].[usp_LogChange] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [etl].[usp_LoadCustomers] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [stg].[EmployeeStage]
    SELECT @RowCount = COUNT(*) FROM stg.EmployeeStage WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[Account]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Account] WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[Category]
    SELECT @RowCount = COUNT(*) FROM dbo.Category WHERE [IsDeleted] = 0;

    -- Reference read: fin.Budget
    SELECT @RowCount = COUNT(*) FROM fin.Budget WHERE [IsDeleted] = 0;

    -- Reference read: stg.OrderStage
    SELECT @RowCount = COUNT(*) FROM stg.OrderStage WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO