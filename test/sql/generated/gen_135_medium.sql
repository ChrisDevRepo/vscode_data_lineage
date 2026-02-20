-- GENERATED SP 135: tier=medium flags=[noBrackets,nestedSubqueries]
-- EXPECT  sources:[dbo].[Address],[rpt].[RegionMetrics],[dbo].[Shipper],[fin].[JournalEntry]  targets:[ops].[Inventory]  exec:[dbo].[usp_ApplyDiscount]

CREATE PROCEDURE [dbo].[usp_GenMedium_135]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    INSERT INTO ops.Inventory ([ID], [Name])
    SELECT x.[ID], x.[Name]
    FROM (
        SELECT i.[ID], i.[Name], ROW_NUMBER() OVER (ORDER BY i.[UpdatedDate] DESC) AS rn
        FROM (
            SELECT [ID], [Name], [UpdatedDate]
            FROM   dbo.Address
            WHERE  [IsDeleted] = 0
        ) AS i
    ) AS x
    WHERE x.rn = 1;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   ops.Inventory AS t
    JOIN   rpt.RegionMetrics AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC dbo.usp_ApplyDiscount @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: dbo.Address
    SELECT @RowCount = COUNT(*) FROM dbo.Address WHERE [IsDeleted] = 0;

    -- Reference read: rpt.RegionMetrics
    SELECT @RowCount = COUNT(*) FROM rpt.RegionMetrics WHERE [IsDeleted] = 0;

    -- Reference read: dbo.Shipper
    SELECT @RowCount = COUNT(*) FROM dbo.Shipper WHERE [IsDeleted] = 0;

    -- Reference read: fin.JournalEntry
    SELECT @RowCount = COUNT(*) FROM fin.JournalEntry WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO