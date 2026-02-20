-- GENERATED SP 56: tier=medium flags=[excessiveDeclare,printStatements]
-- EXPECT  sources:[dbo].[Order],[rpt].[ProductRevenue],[ops].[ReturnOrder],[dbo].[Warehouse]  targets:[dbo].[Category],[dbo].[Shipper]  exec:[dbo].[usp_ArchiveOrders],[audit].[usp_LogAccess]

CREATE PROCEDURE [etl].[usp_GenMedium_056]
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

    INSERT INTO dbo.Category ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [dbo].[Order] AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    PRINT N'Step 1: Processing batch @BatchID = ' + CAST(@BatchID AS NVARCHAR) + N', elapsed: ' + CAST(DATEDIFF(ms, @StartTime, GETUTCDATE()) AS NVARCHAR) + N' ms';

    INSERT INTO [dbo].[Shipper] ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
    FROM   [dbo].[Order] AS a
    JOIN   [rpt].[ProductRevenue] AS c ON c.[ID] = a.[ID]
    JOIN   ops.ReturnOrder AS d ON d.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    PRINT N'Step 2: Processing batch @BatchID = ' + CAST(@BatchID AS NVARCHAR) + N', elapsed: ' + CAST(DATEDIFF(ms, @StartTime, GETUTCDATE()) AS NVARCHAR) + N' ms';

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   dbo.Category AS t
    JOIN   rpt.ProductRevenue AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC dbo.usp_ArchiveOrders @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC audit.usp_LogAccess @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [dbo].[Order]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Order] WHERE [IsDeleted] = 0;

    -- Reference read: rpt.ProductRevenue
    SELECT @RowCount = COUNT(*) FROM rpt.ProductRevenue WHERE [IsDeleted] = 0;

    -- Reference read: [ops].[ReturnOrder]
    SELECT @RowCount = COUNT(*) FROM ops.ReturnOrder WHERE [IsDeleted] = 0;

    -- Reference read: dbo.Warehouse
    SELECT @RowCount = COUNT(*) FROM dbo.Warehouse WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO