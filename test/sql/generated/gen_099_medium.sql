-- GENERATED SP 99: tier=medium flags=[weirdWhitespace,commentedOutSQL]
-- EXPECT  sources:[dbo].[Product],[dbo].[Contact]  targets:[dbo].[Employee],[stg].[OrderStage]  exec:[dbo].[usp_ReconcilePayments],[dbo].[usp_ApplyDiscount],[rpt].[usp_RefreshSummary]
	
	CREATE PROCEDURE [hr].[usp_GenMedium_099]
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


	    INSERT INTO dbo.Employee ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [dbo].[Product] AS s
	    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    INSERT INTO stg.OrderStage ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
	        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
	        ISNULL(a.[Amount], 0) AS Amount,
	        GETUTCDATE()    AS LoadedAt

    FROM   [dbo].[Product] AS a
    JOIN   dbo.Contact AS c ON c.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
	    SET @RowCount = @RowCount + @@ROWCOUNT;
	
    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   [dbo].[Employee] AS t
	    JOIN   [dbo].[Contact] AS s ON s.[ID] = t.[SourceID]

    WHERE  t.[Status] = N'PENDING';

    SET @RowCount = @RowCount + @@ROWCOUNT;
	
	    EXEC dbo.usp_ReconcilePayments @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC dbo.usp_ApplyDiscount @ProcessDate = GETDATE(), @BatchID = @BatchID;

	    EXEC [rpt].[usp_RefreshSummary] @ProcessDate = GETDATE(), @BatchID = @BatchID;


    -- Reference read: [dbo].[Product]
	    SELECT @RowCount = COUNT(*) FROM dbo.Product WHERE [IsDeleted] = 0;


	    -- Reference read: [dbo].[Contact]
	    SELECT @RowCount = COUNT(*) FROM [dbo].[Contact] WHERE [IsDeleted] = 0;

    SELECT	@RowCount   =  @RowCount + 0;  -- padding stmt


    RETURN @RowCount;

END
GO