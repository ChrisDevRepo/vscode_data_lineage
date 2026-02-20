-- GENERATED SP 299: tier=dmv_style flags=[excessiveDeclare,tempTableHeavy]
-- EXPECT  sources:[fin].[Budget],[etl].[BatchControl],[dbo].[Region],[dbo].[OrderLine]  targets:[dbo].[Customer],[etl].[LoadLog]  exec:[dbo].[usp_UpdateCustomer],[dbo].[usp_ProcessOrder],[etl].[usp_LoadProducts]

SET NOCOUNT ON;

CREATE OR ALTER PROCEDURE [hr].[usp_GenDmv_style_299]
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

    -- Pre-stage data in temp tables
    CREATE TABLE #WorkSet ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2), [ProcessedAt] DATETIME);
    INSERT INTO #WorkSet ([ID], [Name], [Amount], [ProcessedAt])
    SELECT [ID], [Name], ISNULL([Amount], 0), GETUTCDATE()
    FROM   fin.Budget
    WHERE  [IsDeleted] = 0;
    CREATE TABLE #RefData ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2), [ProcessedAt] DATETIME);
    INSERT INTO #RefData ([ID], [Name], [Amount], [ProcessedAt])
    SELECT [ID], [Name], ISNULL([Amount], 0), GETUTCDATE()
    FROM   etl.BatchControl
    WHERE  [IsDeleted] = 0;

    INSERT INTO [dbo].[Customer] ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [fin].[Budget] AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    INSERT INTO etl.LoadLog ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
    FROM   fin.Budget AS a
    JOIN   etl.BatchControl AS c ON c.[ID] = a.[ID]
    JOIN   [dbo].[Region] AS d ON d.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   [dbo].[Customer] AS t
    JOIN   [etl].[BatchControl] AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC [dbo].[usp_UpdateCustomer] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC dbo.usp_ProcessOrder @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC etl.usp_LoadProducts @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [fin].[Budget]
    SELECT @RowCount = COUNT(*) FROM [fin].[Budget] WHERE [IsDeleted] = 0;

    -- Reference read: [etl].[BatchControl]
    SELECT @RowCount = COUNT(*) FROM [etl].[BatchControl] WHERE [IsDeleted] = 0;

    -- Reference read: dbo.Region
    SELECT @RowCount = COUNT(*) FROM dbo.Region WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[OrderLine]
    SELECT @RowCount = COUNT(*) FROM [dbo].[OrderLine] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO