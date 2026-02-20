-- GENERATED SP 300: tier=dmv_style flags=[noBrackets,commentedOutSQL]
-- EXPECT  sources:[dbo].[Contact],[dbo].[Shipper],[fin].[JournalEntry],[dbo].[Product]  targets:[dbo].[Category],[dbo].[Payment]  exec:[dbo].[usp_ApplyDiscount],[dbo].[usp_UpdateCustomer],[fin].[usp_PostJournal]

SET NOCOUNT ON;

CREATE OR ALTER PROCEDURE [hr].[usp_GenDmv_style_300]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
WITH EXECUTE AS OWNER
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    -- OLD CODE (removed 2019-06-15) — kept for reference:
    -- INSERT INTO dbo.DeprecatedLog (EntityID, Action, LogDate)
    -- SELECT ID, N'PROCESS', GETDATE() FROM dbo.OldLegacyTable WHERE Status = 0
    -- UPDATE dbo.OldFlag SET Active = 0 WHERE ProcessDate < '2019-01-01'
    -- EXEC dbo.usp_OldArchive @cutoff = '2019-01-01'

    INSERT INTO dbo.Category ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   dbo.Contact AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    INSERT INTO dbo.Payment ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
    FROM   dbo.Contact AS a
    JOIN   dbo.Shipper AS c ON c.[ID] = a.[ID]
    JOIN   fin.JournalEntry AS d ON d.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   dbo.Category AS t
    JOIN   dbo.Shipper AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC dbo.usp_ApplyDiscount @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC dbo.usp_UpdateCustomer @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC fin.usp_PostJournal @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: dbo.Contact
    SELECT @RowCount = COUNT(*) FROM dbo.Contact WHERE [IsDeleted] = 0;

    -- Reference read: dbo.Shipper
    SELECT @RowCount = COUNT(*) FROM dbo.Shipper WHERE [IsDeleted] = 0;

    -- Reference read: fin.JournalEntry
    SELECT @RowCount = COUNT(*) FROM fin.JournalEntry WHERE [IsDeleted] = 0;

    -- Reference read: dbo.Product
    SELECT @RowCount = COUNT(*) FROM dbo.Product WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO