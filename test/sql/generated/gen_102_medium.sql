-- GENERATED SP 102: tier=medium flags=[cursorLoop,commentedOutSQL]
-- EXPECT  sources:[dbo].[Category],[dbo].[Payment],[audit].[ChangeLog],[ops].[Inventory]  targets:[dbo].[Account],[fin].[CostCenter]  exec:[dbo].[usp_GenerateInvoice]

CREATE PROCEDURE [etl].[usp_GenMedium_102]
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

    DECLARE cur_Process CURSOR LOCAL FAST_FORWARD FOR
        SELECT [ID], [Name] FROM [dbo].[Category] WHERE [Status] = N'PENDING';
    
    DECLARE @CurID INT, @CurName NVARCHAR(200);
    OPEN cur_Process;
    FETCH NEXT FROM cur_Process INTO @CurID, @CurName;
    WHILE @@FETCH_STATUS = 0
    BEGIN
        -- Process each row
        SET @BatchID = @CurID;
        PRINT N'Processing: ' + ISNULL(@CurName, N'NULL');
        FETCH NEXT FROM cur_Process INTO @CurID, @CurName;
    END
    CLOSE cur_Process;
    DEALLOCATE cur_Process;

    INSERT INTO [dbo].[Account] ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   dbo.Category AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    INSERT INTO [fin].[CostCenter] ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
    FROM   [dbo].[Category] AS a
    JOIN   [dbo].[Payment] AS c ON c.[ID] = a.[ID]
    JOIN   audit.ChangeLog AS d ON d.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   dbo.Account AS t
    JOIN   dbo.Payment AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC dbo.usp_GenerateInvoice @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: dbo.Category
    SELECT @RowCount = COUNT(*) FROM dbo.Category WHERE [IsDeleted] = 0;

    -- Reference read: dbo.Payment
    SELECT @RowCount = COUNT(*) FROM [dbo].[Payment] WHERE [IsDeleted] = 0;

    -- Reference read: [audit].[ChangeLog]
    SELECT @RowCount = COUNT(*) FROM [audit].[ChangeLog] WHERE [IsDeleted] = 0;

    -- Reference read: [ops].[Inventory]
    SELECT @RowCount = COUNT(*) FROM [ops].[Inventory] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO