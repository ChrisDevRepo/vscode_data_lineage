-- GENERATED SP 296: tier=dmv_style flags=[tempTableHeavy,allCaps]
-- EXPECT  sources:[fin].[CostCenter],[rpt].[RegionMetrics]  targets:[dbo].[Shipper]  EXEC:

SET NOCOUNT ON;

CREATE OR ALTER PROCEDURE [rpt].[usp_GenDmv_style_296]
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

    -- Pre-stage data IN temp tables
    CREATE TABLE #WorkSet ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2), [ProcessedAt] DATETIME);
    INSERT INTO #WorkSet ([ID], [Name], [Amount], [ProcessedAt])
    SELECT [ID], [Name], ISNULL([Amount], 0), GETUTCDATE()
    FROM   [fin].[CostCenter]
    WHERE  [IsDeleted] = 0;
    CREATE TABLE #RefData ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2), [ProcessedAt] DATETIME);
    INSERT INTO #RefData ([ID], [Name], [Amount], [ProcessedAt])
    SELECT [ID], [Name], ISNULL([Amount], 0), GETUTCDATE()
    FROM   rpt.RegionMetrics
    WHERE  [IsDeleted] = 0;

    INSERT INTO dbo.Shipper ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   fin.CostCenter AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   [dbo].[Shipper] AS t
    JOIN   rpt.RegionMetrics AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    -- Reference read: fin.CostCenter
    SELECT @RowCount = COUNT(*) FROM [fin].[CostCenter] WHERE [IsDeleted] = 0;

    -- Reference read: rpt.RegionMetrics
    SELECT @RowCount = COUNT(*) FROM [rpt].[RegionMetrics] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO