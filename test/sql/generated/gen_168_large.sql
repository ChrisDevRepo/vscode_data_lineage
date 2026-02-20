-- GENERATED SP 168: tier=large flags=[bracketedEverything,commentedOutSQL,noBrackets]
-- EXPECT  sources:[dbo].[Department],[dbo].[Address],[hr].[LeaveRequest],[fin].[Transaction],[dbo].[Product]  targets:[dbo].[PriceList],[rpt].[ProductRevenue]  exec:[dbo].[usp_UpdateCustomer],[rpt].[usp_RefreshSummary],[audit].[usp_LogAccess],[dbo].[usp_ProcessOrder]

CREATE PROCEDURE [dbo].[usp_GenLarge_168]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    -- OLD CODE (removed 2019-06-15) — kept for reference:
    -- INSERT INTO dbo.DeprecatedLog (EntityID, Action, LogDate)
    -- SELECT ID, N'PROCESS', GETDATE() FROM dbo.OldLegacyTable WHERE Status = 0
    -- UPDATE dbo.OldFlag SET Active = 0 WHERE ProcessDate < '2019-01-01'
    -- EXEC dbo.usp_OldArchive @cutoff = '2019-01-01'

    INSERT INTO [dbo].[PriceList] ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [dbo].[Department] AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    INSERT INTO [rpt].[ProductRevenue] ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
    FROM   [dbo].[Department] AS a
    JOIN   [dbo].[Address] AS c ON c.[ID] = a.[ID]
    JOIN   [hr].[LeaveRequest] AS d ON d.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   [dbo].[PriceList] AS t
    JOIN   [dbo].[Address] AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    MERGE INTO [rpt].[ProductRevenue] AS tgt
    USING [dbo].[Product] AS src ON src.[ID] = tgt.[ID]
    WHEN MATCHED THEN
        UPDATE SET tgt.[Name] = src.[Name], tgt.[UpdatedDate] = GETUTCDATE()
    WHEN NOT MATCHED BY TARGET THEN
        INSERT ([ID], [Name], [CreatedDate]) VALUES (src.[ID], src.[Name], GETUTCDATE())
    WHEN NOT MATCHED BY SOURCE THEN
        UPDATE SET tgt.[IsDeleted] = 1;

    EXEC [dbo].[usp_UpdateCustomer] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [rpt].[usp_RefreshSummary] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [audit].[usp_LogAccess] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [dbo].[usp_ProcessOrder] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [dbo].[Department]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Department] WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[Address]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Address] WHERE [IsDeleted] = 0;

    -- Reference read: [hr].[LeaveRequest]
    SELECT @RowCount = COUNT(*) FROM [hr].[LeaveRequest] WHERE [IsDeleted] = 0;

    -- Reference read: [fin].[Transaction]
    SELECT @RowCount = COUNT(*) FROM [fin].[Transaction] WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[Product]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Product] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO