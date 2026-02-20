-- GENERATED SP 194: tier=large flags=[deepTryCatch,excessiveDeclare,bracketedEverything]
-- EXPECT  sources:[dbo].[Transaction],[etl].[BatchControl],[dbo].[Shipper]  targets:[dbo].[Employee],[hr].[Department]  exec:[dbo].[usp_UpdateCustomer],[rpt].[usp_RefreshSummary],[dbo].[usp_ArchiveOrders],[etl].[usp_ValidateStage]

CREATE PROCEDURE [hr].[usp_GenLarge_194]
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
            INSERT INTO [dbo].[Employee] ([SourceID], [SourceName], [LoadedAt])
            SELECT s.[ID], s.[Name], GETUTCDATE()
            FROM   [dbo].[Transaction] AS s
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

    BEGIN TRY
        BEGIN TRY
            INSERT INTO [hr].[Department] ([SourceID], [RefID], [Amount], [LoadedAt])
            SELECT
                a.[ID]          AS SourceID,
                b.[ID]          AS RefID,
                ISNULL(a.[Amount], 0) AS Amount,
                GETUTCDATE()    AS LoadedAt
            FROM   [dbo].[Transaction] AS a
            JOIN   [etl].[BatchControl] AS c ON c.[ID] = a.[ID]
            JOIN   [dbo].[Shipper] AS d ON d.[ID] = a.[ID]
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
    FROM   [dbo].[Employee] AS t
    JOIN   [etl].[BatchControl] AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    MERGE INTO [hr].[Department] AS tgt
    USING [dbo].[Shipper] AS src ON src.[ID] = tgt.[ID]
    WHEN MATCHED THEN
        UPDATE SET tgt.[Name] = src.[Name], tgt.[UpdatedDate] = GETUTCDATE()
    WHEN NOT MATCHED BY TARGET THEN
        INSERT ([ID], [Name], [CreatedDate]) VALUES (src.[ID], src.[Name], GETUTCDATE())
    WHEN NOT MATCHED BY SOURCE THEN
        UPDATE SET tgt.[IsDeleted] = 1;

    EXEC [dbo].[usp_UpdateCustomer] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [rpt].[usp_RefreshSummary] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [dbo].[usp_ArchiveOrders] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [etl].[usp_ValidateStage] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [dbo].[Transaction]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Transaction] WHERE [IsDeleted] = 0;

    -- Reference read: [etl].[BatchControl]
    SELECT @RowCount = COUNT(*) FROM [etl].[BatchControl] WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[Shipper]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Shipper] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO