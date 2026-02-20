-- GENERATED SP 297: tier=dmv_style flags=[noBrackets,commentedOutSQL]
-- EXPECT  sources:[fin].[JournalEntry]  targets:[fin].[Transaction],[fin].[Budget]  exec:

SET NOCOUNT ON;

CREATE OR ALTER PROCEDURE [rpt].[usp_GenDmv_style_297]
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

    INSERT INTO fin.Transaction ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   fin.JournalEntry AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    INSERT INTO fin.Budget ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   fin.JournalEntry AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   fin.Transaction AS t
    JOIN   fin.JournalEntry AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    -- Reference read: fin.JournalEntry
    SELECT @RowCount = COUNT(*) FROM fin.JournalEntry WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO