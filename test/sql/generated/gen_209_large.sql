-- GENERATED SP 209: tier=large flags=[allCaps,commentedOutSQL,tempTableHeavy]
-- EXPECT  sources:[dbo].[Department],[dbo].[OrderLine],[etl].[ExtractLog],[dbo].[Shipper]  targets:[fin].[Budget],[rpt].[SalesSummary],[etl].[ErrorLog]  EXEC:[etl].[usp_LoadProducts],[hr].[usp_ApproveLeave],[rpt].[usp_RefreshSummary],[dbo].[usp_ArchiveOrders]

CREATE PROCEDURE [fin].[usp_GenLarge_209]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    -- Pre-stage data IN temp tables
    CREATE TABLE #WorkSet ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2), [ProcessedAt] DATETIME);
    INSERT INTO #WorkSet ([ID], [Name], [Amount], [ProcessedAt])
    SELECT [ID], [Name], ISNULL([Amount], 0), GETUTCDATE()
    FROM   dbo.Department
    WHERE  [IsDeleted] = 0;
    CREATE TABLE #RefData ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2), [ProcessedAt] DATETIME);
    INSERT INTO #RefData ([ID], [Name], [Amount], [ProcessedAt])
    SELECT [ID], [Name], ISNULL([Amount], 0), GETUTCDATE()
    FROM   dbo.OrderLine
    WHERE  [IsDeleted] = 0;

    -- OLD CODE (removed 2019-06-15) — kept for reference:
    -- INSERT INTO dbo.DeprecatedLog (EntityID, Action, LogDate)
    -- SELECT ID, N'PROCESS', GETDATE() FROM dbo.OldLegacyTable WHERE Status = 0
    -- UPDATE dbo.OldFlag SET Active = 0 WHERE ProcessDate < '2019-01-01'
    -- EXEC dbo.usp_OldArchive @cutoff = '2019-01-01'

    INSERT INTO fin.Budget ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   dbo.Department AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    INSERT INTO [rpt].[SalesSummary] ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
    FROM   [dbo].[Department] AS a
    JOIN   dbo.OrderLine AS c ON c.[ID] = a.[ID]
    JOIN   etl.ExtractLog AS d ON d.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    INSERT INTO etl.ErrorLog ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
    FROM   [dbo].[Department] AS a
    JOIN   [dbo].[OrderLine] AS c ON c.[ID] = a.[ID]
    JOIN   [etl].[ExtractLog] AS d ON d.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   [fin].[Budget] AS t
    JOIN   [dbo].[OrderLine] AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    MERGE INTO etl.ErrorLog AS tgt
    USING [dbo].[Shipper] AS src ON src.[ID] = tgt.[ID]
    WHEN MATCHED THEN
        UPDATE SET tgt.[Name] = src.[Name], tgt.[UpdatedDate] = GETUTCDATE()
    WHEN NOT MATCHED BY TARGET THEN
        INSERT ([ID], [Name], [CreatedDate]) VALUES (src.[ID], src.[Name], GETUTCDATE())
    WHEN NOT MATCHED BY SOURCE THEN
        UPDATE SET tgt.[IsDeleted] = 1;

    EXEC etl.usp_LoadProducts @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [hr].[usp_ApproveLeave] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC rpt.usp_RefreshSummary @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC dbo.usp_ArchiveOrders @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [dbo].[Department]
    SELECT @RowCount = COUNT(*) FROM dbo.Department WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[OrderLine]
    SELECT @RowCount = COUNT(*) FROM [dbo].[OrderLine] WHERE [IsDeleted] = 0;

    -- Reference read: etl.ExtractLog
    SELECT @RowCount = COUNT(*) FROM [etl].[ExtractLog] WHERE [IsDeleted] = 0;

    -- Reference read: dbo.Shipper
    SELECT @RowCount = COUNT(*) FROM [dbo].[Shipper] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO