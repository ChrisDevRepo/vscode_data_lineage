-- GENERATED SP 68: tier=medium flags=[tempTableHeavy,noBrackets]
-- EXPECT  sources:[hr].[Performance],[dbo].[Customer],[hr].[LeaveRequest],[etl].[ErrorLog]  targets:[rpt].[ProductRevenue]  exec:[rpt].[usp_RefreshSummary],[dbo].[usp_ApplyDiscount],[dbo].[usp_ProcessOrder]

CREATE PROCEDURE [rpt].[usp_GenMedium_068]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    -- Pre-stage data in temp tables
    CREATE TABLE #WorkSet ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2), [ProcessedAt] DATETIME);
    INSERT INTO #WorkSet ([ID], [Name], [Amount], [ProcessedAt])
    SELECT [ID], [Name], ISNULL([Amount], 0), GETUTCDATE()
    FROM   hr.Performance
    WHERE  [IsDeleted] = 0;
    CREATE TABLE #RefData ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2), [ProcessedAt] DATETIME);
    INSERT INTO #RefData ([ID], [Name], [Amount], [ProcessedAt])
    SELECT [ID], [Name], ISNULL([Amount], 0), GETUTCDATE()
    FROM   dbo.Customer
    WHERE  [IsDeleted] = 0;

    INSERT INTO rpt.ProductRevenue ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   hr.Performance AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   rpt.ProductRevenue AS t
    JOIN   dbo.Customer AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC rpt.usp_RefreshSummary @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC dbo.usp_ApplyDiscount @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC dbo.usp_ProcessOrder @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: hr.Performance
    SELECT @RowCount = COUNT(*) FROM hr.Performance WHERE [IsDeleted] = 0;

    -- Reference read: dbo.Customer
    SELECT @RowCount = COUNT(*) FROM dbo.Customer WHERE [IsDeleted] = 0;

    -- Reference read: hr.LeaveRequest
    SELECT @RowCount = COUNT(*) FROM hr.LeaveRequest WHERE [IsDeleted] = 0;

    -- Reference read: etl.ErrorLog
    SELECT @RowCount = COUNT(*) FROM etl.ErrorLog WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO