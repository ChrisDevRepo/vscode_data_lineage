-- GENERATED SP 285: tier=dmv_style flags=[deepTryCatch,excessiveDeclare]
-- EXPECT  sources:[hr].[Employee],[stg].[CustomerStage],[dbo].[Warehouse],[etl].[ExtractLog]  targets:[rpt].[EmployeePerf],[dbo].[Category]  exec:

SET NOCOUNT ON;

CREATE OR ALTER PROCEDURE [rpt].[usp_GenDmv_style_285]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
WITH EXECUTE AS OWNER
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
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
            INSERT INTO rpt.EmployeePerf ([SourceID], [SourceName], [LoadedAt])
            SELECT s.[ID], s.[Name], GETUTCDATE()
            FROM   hr.Employee AS s
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
            INSERT INTO dbo.Category ([SourceID], [RefID], [Amount], [LoadedAt])
            SELECT
                a.[ID]          AS SourceID,
                b.[ID]          AS RefID,
                ISNULL(a.[Amount], 0) AS Amount,
                GETUTCDATE()    AS LoadedAt
            FROM   hr.Employee AS a
            JOIN   stg.CustomerStage AS c ON c.[ID] = a.[ID]
            JOIN   dbo.Warehouse AS d ON d.[ID] = a.[ID]
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
    FROM   [rpt].[EmployeePerf] AS t
    JOIN   stg.CustomerStage AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    -- Reference read: [hr].[Employee]
    SELECT @RowCount = COUNT(*) FROM hr.Employee WHERE [IsDeleted] = 0;

    -- Reference read: [stg].[CustomerStage]
    SELECT @RowCount = COUNT(*) FROM stg.CustomerStage WHERE [IsDeleted] = 0;

    -- Reference read: dbo.Warehouse
    SELECT @RowCount = COUNT(*) FROM [dbo].[Warehouse] WHERE [IsDeleted] = 0;

    -- Reference read: etl.ExtractLog
    SELECT @RowCount = COUNT(*) FROM [etl].[ExtractLog] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO