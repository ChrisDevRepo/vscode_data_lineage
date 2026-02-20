-- GENERATED SP 55: tier=medium flags=[commentedOutSQL,noBrackets]
-- EXPECT  sources:[stg].[PaymentStage],[dbo].[Region],[etl].[ErrorLog],[rpt].[ProductRevenue]  targets:[dbo].[Product]  exec:[dbo].[usp_GenerateInvoice]

CREATE PROCEDURE [rpt].[usp_GenMedium_055]
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

    INSERT INTO dbo.Product ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   stg.PaymentStage AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   dbo.Product AS t
    JOIN   dbo.Region AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC dbo.usp_GenerateInvoice @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: stg.PaymentStage
    SELECT @RowCount = COUNT(*) FROM stg.PaymentStage WHERE [IsDeleted] = 0;

    -- Reference read: dbo.Region
    SELECT @RowCount = COUNT(*) FROM dbo.Region WHERE [IsDeleted] = 0;

    -- Reference read: etl.ErrorLog
    SELECT @RowCount = COUNT(*) FROM etl.ErrorLog WHERE [IsDeleted] = 0;

    -- Reference read: rpt.ProductRevenue
    SELECT @RowCount = COUNT(*) FROM rpt.ProductRevenue WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO