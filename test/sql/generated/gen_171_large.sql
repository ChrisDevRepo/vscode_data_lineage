-- GENERATED SP 171: tier=large flags=[variableTableHeavy,transactionBlocks,excessiveDeclare]
-- EXPECT  sources:[stg].[ProductStage],[dbo].[PriceList],[stg].[CustomerStage],[fin].[Account],[rpt].[ProductRevenue],[stg].[PaymentStage]  targets:[dbo].[OrderLine],[dbo].[Address]  exec:[etl].[usp_LoadProducts],[hr].[usp_ApproveLeave],[dbo].[usp_GenerateInvoice],[dbo].[usp_ApplyDiscount],[dbo].[usp_ProcessOrder],[audit].[usp_LogAccess]

CREATE PROCEDURE [ops].[usp_GenLarge_171]
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

    BEGIN TRANSACTION;
    INSERT INTO dbo.OrderLine ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [stg].[ProductStage] AS s
    WHERE  s.[IsDeleted] = 0;
    IF @@ERROR = 0
        COMMIT TRANSACTION;
    ELSE
        ROLLBACK TRANSACTION;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    INSERT INTO [dbo].[Address] ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
    FROM   [stg].[ProductStage] AS a
    JOIN   [dbo].[PriceList] AS c ON c.[ID] = a.[ID]
    JOIN   [stg].[CustomerStage] AS d ON d.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   [dbo].[OrderLine] AS t
    JOIN   [dbo].[PriceList] AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    MERGE INTO [dbo].[Address] AS tgt
    USING stg.PaymentStage AS src ON src.[ID] = tgt.[ID]
    WHEN MATCHED THEN
        UPDATE SET tgt.[Name] = src.[Name], tgt.[UpdatedDate] = GETUTCDATE()
    WHEN NOT MATCHED BY TARGET THEN
        INSERT ([ID], [Name], [CreatedDate]) VALUES (src.[ID], src.[Name], GETUTCDATE())
    WHEN NOT MATCHED BY SOURCE THEN
        UPDATE SET tgt.[IsDeleted] = 1;

    EXEC etl.usp_LoadProducts @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [hr].[usp_ApproveLeave] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC dbo.usp_GenerateInvoice @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC dbo.usp_ApplyDiscount @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC dbo.usp_ProcessOrder @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [audit].[usp_LogAccess] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: stg.ProductStage
    SELECT @RowCount = COUNT(*) FROM stg.ProductStage WHERE [IsDeleted] = 0;

    -- Reference read: dbo.PriceList
    SELECT @RowCount = COUNT(*) FROM [dbo].[PriceList] WHERE [IsDeleted] = 0;

    -- Reference read: stg.CustomerStage
    SELECT @RowCount = COUNT(*) FROM stg.CustomerStage WHERE [IsDeleted] = 0;

    -- Reference read: fin.Account
    SELECT @RowCount = COUNT(*) FROM [fin].[Account] WHERE [IsDeleted] = 0;

    -- Reference read: [rpt].[ProductRevenue]
    SELECT @RowCount = COUNT(*) FROM rpt.ProductRevenue WHERE [IsDeleted] = 0;

    -- Reference read: stg.PaymentStage
    SELECT @RowCount = COUNT(*) FROM stg.PaymentStage WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO