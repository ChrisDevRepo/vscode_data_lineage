-- GENERATED SP 82: tier=medium flags=[tempTableHeavy,commentedOutSQL]
-- EXPECT  sources:[rpt].[CustomerChurn],[audit].[AccessLog],[dbo].[Invoice]  targets:[dbo].[Transaction]  exec:[dbo].[usp_ArchiveOrders],[etl].[usp_LoadOrders]

CREATE PROCEDURE [etl].[usp_GenMedium_082]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    -- Pre-stage data in temp tables
    CREATE TABLE #WorkSet ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2), [ProcessedAt] DATETIME);
    INSERT INTO #WorkSet ([ID], [Name], [Amount], [ProcessedAt])
    SELECT [ID], [Name], ISNULL([Amount], 0), GETUTCDATE()
    FROM   [rpt].[CustomerChurn]
    WHERE  [IsDeleted] = 0;
    CREATE TABLE #RefData ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2), [ProcessedAt] DATETIME);
    INSERT INTO #RefData ([ID], [Name], [Amount], [ProcessedAt])
    SELECT [ID], [Name], ISNULL([Amount], 0), GETUTCDATE()
    FROM   audit.AccessLog
    WHERE  [IsDeleted] = 0;

    -- OLD CODE (removed 2019-06-15) — kept for reference:
    -- INSERT INTO dbo.DeprecatedLog (EntityID, Action, LogDate)
    -- SELECT ID, N'PROCESS', GETDATE() FROM dbo.OldLegacyTable WHERE Status = 0
    -- UPDATE dbo.OldFlag SET Active = 0 WHERE ProcessDate < '2019-01-01'
    -- EXEC dbo.usp_OldArchive @cutoff = '2019-01-01'

    INSERT INTO dbo.Transaction ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [rpt].[CustomerChurn] AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   dbo.Transaction AS t
    JOIN   [audit].[AccessLog] AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC [dbo].[usp_ArchiveOrders] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [etl].[usp_LoadOrders] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: rpt.CustomerChurn
    SELECT @RowCount = COUNT(*) FROM [rpt].[CustomerChurn] WHERE [IsDeleted] = 0;

    -- Reference read: audit.AccessLog
    SELECT @RowCount = COUNT(*) FROM audit.AccessLog WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[Invoice]
    SELECT @RowCount = COUNT(*) FROM dbo.Invoice WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO