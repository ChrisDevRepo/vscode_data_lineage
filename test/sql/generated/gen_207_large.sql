-- GENERATED SP 207: tier=large flags=[variableTableHeavy,excessiveDeclare,bracketedEverything]
-- EXPECT  sources:[dbo].[Department],[dbo].[Customer],[dbo].[Transaction]  targets:[rpt].[SalesSummary],[dbo].[Payment]  exec:[etl].[usp_LoadProducts],[dbo].[usp_ReconcilePayments],[dbo].[usp_UpdateCustomer],[dbo].[usp_ArchiveOrders],[dbo].[usp_ProcessOrder]

CREATE PROCEDURE [ops].[usp_GenLarge_207]
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

    DECLARE @TempBuffer TABLE ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2));
    -- @table variable populated from logic above — not a catalog dependency
    DECLARE @StagingRows TABLE ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2));
    -- @table variable populated from logic above — not a catalog dependency

    INSERT INTO [rpt].[SalesSummary] ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [dbo].[Department] AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    INSERT INTO [dbo].[Payment] ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
    FROM   [dbo].[Department] AS a
    JOIN   [dbo].[Customer] AS c ON c.[ID] = a.[ID]
    JOIN   [dbo].[Transaction] AS d ON d.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   [rpt].[SalesSummary] AS t
    JOIN   [dbo].[Customer] AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    MERGE INTO [dbo].[Payment] AS tgt
    USING [dbo].[Transaction] AS src ON src.[ID] = tgt.[ID]
    WHEN MATCHED THEN
        UPDATE SET tgt.[Name] = src.[Name], tgt.[UpdatedDate] = GETUTCDATE()
    WHEN NOT MATCHED BY TARGET THEN
        INSERT ([ID], [Name], [CreatedDate]) VALUES (src.[ID], src.[Name], GETUTCDATE())
    WHEN NOT MATCHED BY SOURCE THEN
        UPDATE SET tgt.[IsDeleted] = 1;

    EXEC [etl].[usp_LoadProducts] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [dbo].[usp_ReconcilePayments] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [dbo].[usp_UpdateCustomer] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [dbo].[usp_ArchiveOrders] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [dbo].[usp_ProcessOrder] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [dbo].[Department]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Department] WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[Customer]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Customer] WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[Transaction]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Transaction] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO