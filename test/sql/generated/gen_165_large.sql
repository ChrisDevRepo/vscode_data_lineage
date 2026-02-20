-- GENERATED SP 165: tier=large flags=[nestedSubqueries,variableTableHeavy,commentedOutSQL]
-- EXPECT  sources:[dbo].[Customer],[ops].[Inventory],[ops].[PickList],[rpt].[SalesSummary]  targets:[audit].[ChangeLog],[fin].[Account],[etl].[BatchControl]  exec:[fin].[usp_PostJournal],[dbo].[usp_UpdateCustomer],[etl].[usp_LoadProducts],[etl].[usp_LoadOrders],[dbo].[usp_ApplyDiscount]

CREATE PROCEDURE [hr].[usp_GenLarge_165]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    DECLARE @TempBuffer TABLE ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2));
    -- @table variable populated from logic above — not a catalog dependency
    DECLARE @StagingRows TABLE ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2));
    -- @table variable populated from logic above — not a catalog dependency

    -- OLD CODE (removed 2019-06-15) — kept for reference:
    -- INSERT INTO dbo.DeprecatedLog (EntityID, Action, LogDate)
    -- SELECT ID, N'PROCESS', GETDATE() FROM dbo.OldLegacyTable WHERE Status = 0
    -- UPDATE dbo.OldFlag SET Active = 0 WHERE ProcessDate < '2019-01-01'
    -- EXEC dbo.usp_OldArchive @cutoff = '2019-01-01'

    INSERT INTO [audit].[ChangeLog] ([ID], [Name])
    SELECT x.[ID], x.[Name]
    FROM (
        SELECT i.[ID], i.[Name], ROW_NUMBER() OVER (ORDER BY i.[UpdatedDate] DESC) AS rn
        FROM (
            SELECT [ID], [Name], [UpdatedDate]
            FROM   dbo.Customer
            WHERE  [IsDeleted] = 0
        ) AS i
    ) AS x
    WHERE x.rn = 1;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    INSERT INTO fin.Account ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
    FROM   [dbo].[Customer] AS a
    JOIN   ops.Inventory AS c ON c.[ID] = a.[ID]
    JOIN   [ops].[PickList] AS d ON d.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    INSERT INTO etl.BatchControl ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
    FROM   dbo.Customer AS a
    JOIN   ops.Inventory AS c ON c.[ID] = a.[ID]
    JOIN   ops.PickList AS d ON d.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   [audit].[ChangeLog] AS t
    JOIN   ops.Inventory AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    MERGE INTO etl.BatchControl AS tgt
    USING rpt.SalesSummary AS src ON src.[ID] = tgt.[ID]
    WHEN MATCHED THEN
        UPDATE SET tgt.[Name] = src.[Name], tgt.[UpdatedDate] = GETUTCDATE()
    WHEN NOT MATCHED BY TARGET THEN
        INSERT ([ID], [Name], [CreatedDate]) VALUES (src.[ID], src.[Name], GETUTCDATE())
    WHEN NOT MATCHED BY SOURCE THEN
        UPDATE SET tgt.[IsDeleted] = 1;

    EXEC [fin].[usp_PostJournal] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [dbo].[usp_UpdateCustomer] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC etl.usp_LoadProducts @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC etl.usp_LoadOrders @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [dbo].[usp_ApplyDiscount] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [dbo].[Customer]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Customer] WHERE [IsDeleted] = 0;

    -- Reference read: [ops].[Inventory]
    SELECT @RowCount = COUNT(*) FROM ops.Inventory WHERE [IsDeleted] = 0;

    -- Reference read: [ops].[PickList]
    SELECT @RowCount = COUNT(*) FROM [ops].[PickList] WHERE [IsDeleted] = 0;

    -- Reference read: rpt.SalesSummary
    SELECT @RowCount = COUNT(*) FROM rpt.SalesSummary WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO