-- GENERATED SP 213: tier=large flags=[excessiveDeclare,bracketedEverything,commentedOutSQL]
-- EXPECT  sources:[rpt].[CustomerChurn],[dbo].[Employee],[ops].[PickList]  targets:[rpt].[RegionMetrics],[dbo].[Department]  exec:[dbo].[usp_UpdateCustomer],[audit].[usp_LogAccess],[rpt].[usp_RefreshSummary],[dbo].[usp_ProcessOrder],[etl].[usp_ValidateStage],[dbo].[usp_ApplyDiscount]

CREATE PROCEDURE [rpt].[usp_GenLarge_213]
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

    INSERT INTO [rpt].[RegionMetrics] ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [rpt].[CustomerChurn] AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    INSERT INTO [dbo].[Department] ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
    FROM   [rpt].[CustomerChurn] AS a
    JOIN   [dbo].[Employee] AS c ON c.[ID] = a.[ID]
    JOIN   [ops].[PickList] AS d ON d.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   [rpt].[RegionMetrics] AS t
    JOIN   [dbo].[Employee] AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    MERGE INTO [dbo].[Department] AS tgt
    USING [ops].[PickList] AS src ON src.[ID] = tgt.[ID]
    WHEN MATCHED THEN
        UPDATE SET tgt.[Name] = src.[Name], tgt.[UpdatedDate] = GETUTCDATE()
    WHEN NOT MATCHED BY TARGET THEN
        INSERT ([ID], [Name], [CreatedDate]) VALUES (src.[ID], src.[Name], GETUTCDATE())
    WHEN NOT MATCHED BY SOURCE THEN
        UPDATE SET tgt.[IsDeleted] = 1;

    EXEC [dbo].[usp_UpdateCustomer] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [audit].[usp_LogAccess] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [rpt].[usp_RefreshSummary] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [dbo].[usp_ProcessOrder] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [etl].[usp_ValidateStage] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [dbo].[usp_ApplyDiscount] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [rpt].[CustomerChurn]
    SELECT @RowCount = COUNT(*) FROM [rpt].[CustomerChurn] WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[Employee]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Employee] WHERE [IsDeleted] = 0;

    -- Reference read: [ops].[PickList]
    SELECT @RowCount = COUNT(*) FROM [ops].[PickList] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO