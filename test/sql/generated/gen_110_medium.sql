-- GENERATED SP 110: tier=medium flags=[tempTableHeavy,variableTableHeavy]
-- EXPECT  sources:[rpt].[MonthlyOrders],[dbo].[Payment]  targets:[dbo].[Account]  exec:[etl].[usp_LoadProducts]

CREATE PROCEDURE [hr].[usp_GenMedium_110]
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

    -- Pre-stage data in temp tables
    CREATE TABLE #WorkSet ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2), [ProcessedAt] DATETIME);
    INSERT INTO #WorkSet ([ID], [Name], [Amount], [ProcessedAt])
    SELECT [ID], [Name], ISNULL([Amount], 0), GETUTCDATE()
    FROM   rpt.MonthlyOrders
    WHERE  [IsDeleted] = 0;
    CREATE TABLE #RefData ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2), [ProcessedAt] DATETIME);
    INSERT INTO #RefData ([ID], [Name], [Amount], [ProcessedAt])
    SELECT [ID], [Name], ISNULL([Amount], 0), GETUTCDATE()
    FROM   [dbo].[Payment]
    WHERE  [IsDeleted] = 0;

    INSERT INTO [dbo].[Account] ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   rpt.MonthlyOrders AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   [dbo].[Account] AS t
    JOIN   [dbo].[Payment] AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC etl.usp_LoadProducts @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [rpt].[MonthlyOrders]
    SELECT @RowCount = COUNT(*) FROM [rpt].[MonthlyOrders] WHERE [IsDeleted] = 0;

    -- Reference read: dbo.Payment
    SELECT @RowCount = COUNT(*) FROM dbo.Payment WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO