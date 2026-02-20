-- GENERATED SP 97: tier=medium flags=[printStatements,allCaps]
-- EXPECT  sources:[dbo].[TRANSACTION],[dbo].[Shipper]  targets:[rpt].[CustomerChurn],[rpt].[SalesSummary]  EXEC:[hr].[usp_ApproveLeave]

CREATE PROCEDURE [ops].[usp_GenMedium_097]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    INSERT INTO rpt.CustomerChurn ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   dbo.TRANSACTION AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    PRINT N'Step 1: Processing batch @BatchID = ' + CAST(@BatchID AS NVARCHAR) + N', elapsed: ' + CAST(DATEDIFF(ms, @StartTime, GETUTCDATE()) AS NVARCHAR) + N' ms';

    INSERT INTO rpt.SalesSummary ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
    FROM   [dbo].[TRANSACTION] AS a
    JOIN   dbo.Shipper AS c ON c.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    PRINT N'Step 2: Processing batch @BatchID = ' + CAST(@BatchID AS NVARCHAR) + N', elapsed: ' + CAST(DATEDIFF(ms, @StartTime, GETUTCDATE()) AS NVARCHAR) + N' ms';

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   [rpt].[CustomerChurn] AS t
    JOIN   dbo.Shipper AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC hr.usp_ApproveLeave @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: dbo.TRANSACTION
    SELECT @RowCount = COUNT(*) FROM [dbo].[TRANSACTION] WHERE [IsDeleted] = 0;

    -- Reference read: dbo.Shipper
    SELECT @RowCount = COUNT(*) FROM dbo.Shipper WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO