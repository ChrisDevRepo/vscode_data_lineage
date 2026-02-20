-- GENERATED SP 132: tier=medium flags=[variableTableHeavy,noBrackets]
-- EXPECT  sources:[rpt].[RegionMetrics],[ops].[Shipment],[ops].[PickList]  targets:[dbo].[Department],[audit].[AccessLog]  exec:[dbo].[usp_ApplyDiscount],[etl].[usp_LoadOrders],[dbo].[usp_ProcessOrder]

CREATE PROCEDURE [etl].[usp_GenMedium_132]
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

    INSERT INTO dbo.Department ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   rpt.RegionMetrics AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    INSERT INTO audit.AccessLog ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
    FROM   rpt.RegionMetrics AS a
    JOIN   ops.Shipment AS c ON c.[ID] = a.[ID]
    JOIN   ops.PickList AS d ON d.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   dbo.Department AS t
    JOIN   ops.Shipment AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC dbo.usp_ApplyDiscount @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC etl.usp_LoadOrders @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC dbo.usp_ProcessOrder @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: rpt.RegionMetrics
    SELECT @RowCount = COUNT(*) FROM rpt.RegionMetrics WHERE [IsDeleted] = 0;

    -- Reference read: ops.Shipment
    SELECT @RowCount = COUNT(*) FROM ops.Shipment WHERE [IsDeleted] = 0;

    -- Reference read: ops.PickList
    SELECT @RowCount = COUNT(*) FROM ops.PickList WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO