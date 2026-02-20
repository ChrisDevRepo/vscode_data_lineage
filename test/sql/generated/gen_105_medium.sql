-- GENERATED SP 105: tier=medium flags=[commentedOutSQL,nestedSubqueries]
-- EXPECT  sources:[dbo].[Invoice],[ops].[ReturnOrder]  targets:[rpt].[EmployeePerf],[dbo].[Account]  exec:[dbo].[usp_UpdateCustomer]

CREATE PROCEDURE [etl].[usp_GenMedium_105]
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

    INSERT INTO [rpt].[EmployeePerf] ([ID], [Name])
    SELECT x.[ID], x.[Name]
    FROM (
        SELECT i.[ID], i.[Name], ROW_NUMBER() OVER (ORDER BY i.[UpdatedDate] DESC) AS rn
        FROM (
            SELECT [ID], [Name], [UpdatedDate]
            FROM   dbo.Invoice
            WHERE  [IsDeleted] = 0
        ) AS i
    ) AS x
    WHERE x.rn = 1;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    INSERT INTO dbo.Account ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
    FROM   dbo.Invoice AS a
    JOIN   ops.ReturnOrder AS c ON c.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   [rpt].[EmployeePerf] AS t
    JOIN   ops.ReturnOrder AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC [dbo].[usp_UpdateCustomer] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [dbo].[Invoice]
    SELECT @RowCount = COUNT(*) FROM dbo.Invoice WHERE [IsDeleted] = 0;

    -- Reference read: ops.ReturnOrder
    SELECT @RowCount = COUNT(*) FROM [ops].[ReturnOrder] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO