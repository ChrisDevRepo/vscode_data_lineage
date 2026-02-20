-- GENERATED SP 75: tier=medium flags=[allCaps,printStatements]
-- EXPECT  sources:[rpt].[MonthlyOrders],[dbo].[TRANSACTION],[fin].[CostCenter],[audit].[ChangeLog]  targets:[dbo].[Department],[rpt].[SalesSummary]  EXEC:[etl].[usp_LoadProducts],[dbo].[usp_GenerateInvoice]

CREATE PROCEDURE [rpt].[usp_GenMedium_075]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    INSERT INTO dbo.Department ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [rpt].[MonthlyOrders] AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    PRINT N'Step 1: Processing batch @BatchID = ' + CAST(@BatchID AS NVARCHAR) + N', elapsed: ' + CAST(DATEDIFF(ms, @StartTime, GETUTCDATE()) AS NVARCHAR) + N' ms';

    INSERT INTO rpt.SalesSummary ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
    FROM   rpt.MonthlyOrders AS a
    JOIN   [dbo].[TRANSACTION] AS c ON c.[ID] = a.[ID]
    JOIN   fin.CostCenter AS d ON d.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    PRINT N'Step 2: Processing batch @BatchID = ' + CAST(@BatchID AS NVARCHAR) + N', elapsed: ' + CAST(DATEDIFF(ms, @StartTime, GETUTCDATE()) AS NVARCHAR) + N' ms';

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   dbo.Department AS t
    JOIN   dbo.TRANSACTION AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC [etl].[usp_LoadProducts] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [dbo].[usp_GenerateInvoice] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [rpt].[MonthlyOrders]
    SELECT @RowCount = COUNT(*) FROM rpt.MonthlyOrders WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[TRANSACTION]
    SELECT @RowCount = COUNT(*) FROM dbo.TRANSACTION WHERE [IsDeleted] = 0;

    -- Reference read: fin.CostCenter
    SELECT @RowCount = COUNT(*) FROM [fin].[CostCenter] WHERE [IsDeleted] = 0;

    -- Reference read: audit.ChangeLog
    SELECT @RowCount = COUNT(*) FROM audit.ChangeLog WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO