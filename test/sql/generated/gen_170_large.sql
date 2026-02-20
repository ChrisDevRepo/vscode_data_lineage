-- GENERATED SP 170: tier=large flags=[allCaps,printStatements,nestedSubqueries]
-- EXPECT  sources:[ops].[Shipment],[rpt].[RegionMetrics],[fin].[JournalEntry],[fin].[Budget],[dbo].[Account]  targets:[dbo].[PriceList],[dbo].[Customer]  EXEC:[dbo].[usp_ProcessOrder],[dbo].[usp_UpdateCustomer],[audit].[usp_LogAccess],[fin].[usp_PostJournal]

CREATE PROCEDURE [etl].[usp_GenLarge_170]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    INSERT INTO [dbo].[PriceList] ([ID], [Name])
    SELECT x.[ID], x.[Name]
    FROM (
        SELECT i.[ID], i.[Name], ROW_NUMBER() OVER (ORDER BY i.[UpdatedDate] DESC) AS rn
        FROM (
            SELECT [ID], [Name], [UpdatedDate]
            FROM   [ops].[Shipment]
            WHERE  [IsDeleted] = 0
        ) AS i
    ) AS x
    WHERE x.rn = 1;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    PRINT N'Step 1: Processing batch @BatchID = ' + CAST(@BatchID AS NVARCHAR) + N', elapsed: ' + CAST(DATEDIFF(ms, @StartTime, GETUTCDATE()) AS NVARCHAR) + N' ms';

    INSERT INTO dbo.Customer ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
    FROM   ops.Shipment AS a
    JOIN   rpt.RegionMetrics AS c ON c.[ID] = a.[ID]
    JOIN   fin.JournalEntry AS d ON d.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    PRINT N'Step 2: Processing batch @BatchID = ' + CAST(@BatchID AS NVARCHAR) + N', elapsed: ' + CAST(DATEDIFF(ms, @StartTime, GETUTCDATE()) AS NVARCHAR) + N' ms';

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   dbo.PriceList AS t
    JOIN   rpt.RegionMetrics AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    MERGE INTO [dbo].[Customer] AS tgt
    USING dbo.Account AS src ON src.[ID] = tgt.[ID]
    WHEN MATCHED THEN
        UPDATE SET tgt.[Name] = src.[Name], tgt.[UpdatedDate] = GETUTCDATE()
    WHEN NOT MATCHED BY TARGET THEN
        INSERT ([ID], [Name], [CreatedDate]) VALUES (src.[ID], src.[Name], GETUTCDATE())
    WHEN NOT MATCHED BY SOURCE THEN
        UPDATE SET tgt.[IsDeleted] = 1;

    EXEC dbo.usp_ProcessOrder @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC dbo.usp_UpdateCustomer @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [audit].[usp_LogAccess] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC fin.usp_PostJournal @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [ops].[Shipment]
    SELECT @RowCount = COUNT(*) FROM ops.Shipment WHERE [IsDeleted] = 0;

    -- Reference read: [rpt].[RegionMetrics]
    SELECT @RowCount = COUNT(*) FROM rpt.RegionMetrics WHERE [IsDeleted] = 0;

    -- Reference read: [fin].[JournalEntry]
    SELECT @RowCount = COUNT(*) FROM fin.JournalEntry WHERE [IsDeleted] = 0;

    -- Reference read: fin.Budget
    SELECT @RowCount = COUNT(*) FROM fin.Budget WHERE [IsDeleted] = 0;

    -- Reference read: dbo.Account
    SELECT @RowCount = COUNT(*) FROM [dbo].[Account] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO