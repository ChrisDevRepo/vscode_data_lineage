-- GENERATED SP 10: tier=tiny flags=[commentedOutSQL]
-- EXPECT  sources:[fin].[CostCenter],[dbo].[Invoice]  targets:[rpt].[RegionMetrics]  exec:

CREATE PROCEDURE [ops].[usp_GenTiny_010]
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

    INSERT INTO [rpt].[RegionMetrics] ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   fin.CostCenter AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    -- Reference read: fin.CostCenter
    SELECT @RowCount = COUNT(*) FROM fin.CostCenter WHERE [IsDeleted] = 0;

    -- Reference read: dbo.Invoice
    SELECT @RowCount = COUNT(*) FROM dbo.Invoice WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO