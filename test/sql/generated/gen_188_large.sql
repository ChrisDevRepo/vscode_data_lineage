-- GENERATED SP 188: tier=large flags=[commentedOutSQL,variableTableHeavy,allCaps]
-- EXPECT  sources:[rpt].[CustomerChurn],[dbo].[SalesTarget],[dbo].[Customer]  targets:[hr].[Employee],[dbo].[Product]  EXEC:[fin].[usp_PostJournal],[audit].[usp_LogChange],[etl].[usp_LoadOrders],[dbo].[usp_ApplyDiscount]

CREATE PROCEDURE [rpt].[usp_GenLarge_188]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    DECLARE @TempBuffer TABLE ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2));
    -- @TABLE variable populated FROM logic above — NOT a catalog dependency
    DECLARE @StagingRows TABLE ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2));
    -- @TABLE variable populated FROM logic above — NOT a catalog dependency

    -- OLD CODE (removed 2019-06-15) — kept for reference:
    -- INSERT INTO dbo.DeprecatedLog (EntityID, Action, LogDate)
    -- SELECT ID, N'PROCESS', GETDATE() FROM dbo.OldLegacyTable WHERE Status = 0
    -- UPDATE dbo.OldFlag SET Active = 0 WHERE ProcessDate < '2019-01-01'
    -- EXEC dbo.usp_OldArchive @cutoff = '2019-01-01'

    INSERT INTO hr.Employee ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [rpt].[CustomerChurn] AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    INSERT INTO dbo.Product ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
    FROM   rpt.CustomerChurn AS a
    JOIN   [dbo].[SalesTarget] AS c ON c.[ID] = a.[ID]
    JOIN   dbo.Customer AS d ON d.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   hr.Employee AS t
    JOIN   dbo.SalesTarget AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    MERGE INTO dbo.Product AS tgt
    USING [dbo].[Customer] AS src ON src.[ID] = tgt.[ID]
    WHEN MATCHED THEN
        UPDATE SET tgt.[Name] = src.[Name], tgt.[UpdatedDate] = GETUTCDATE()
    WHEN NOT MATCHED BY TARGET THEN
        INSERT ([ID], [Name], [CreatedDate]) VALUES (src.[ID], src.[Name], GETUTCDATE())
    WHEN NOT MATCHED BY SOURCE THEN
        UPDATE SET tgt.[IsDeleted] = 1;

    EXEC fin.usp_PostJournal @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC audit.usp_LogChange @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC etl.usp_LoadOrders @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC dbo.usp_ApplyDiscount @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: rpt.CustomerChurn
    SELECT @RowCount = COUNT(*) FROM rpt.CustomerChurn WHERE [IsDeleted] = 0;

    -- Reference read: dbo.SalesTarget
    SELECT @RowCount = COUNT(*) FROM dbo.SalesTarget WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[Customer]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Customer] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO