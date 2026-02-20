-- GENERATED SP 169: tier=large flags=[noBrackets,weirdWhitespace,massiveComments]
-- EXPECT  sources:[etl].[LoadLog],[dbo].[Order],[stg].[ProductStage],[dbo].[Warehouse],[etl].[BatchControl],[stg].[CustomerStage]  targets:[dbo].[Payment],[dbo].[Department]  exec:[dbo].[usp_UpdateCustomer],[dbo].[usp_ArchiveOrders],[dbo].[usp_ProcessOrder],[etl].[usp_LoadProducts],[dbo].[usp_ApplyDiscount],[fin].[usp_PostJournal]

CREATE PROCEDURE [etl].[usp_GenLarge_169]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
	    DECLARE @StartTime DATETIME = GETUTCDATE();
	
	    /*
     * ─── Processing Block 1 ─────────────────────────────────────────────────
     * This section handles the core ETL for batch 1.
     * Original implementation: 2015-03-12 (developer: J.Smith)
     * Last modified: 2022-11-08 (developer: M.Jones) — added retry logic
	     *
	     * LEGACY NOTE: The following was removed in v3.2:

     *   -- INSERT INTO dbo.OldArchive SELECT * FROM dbo.Deprecated WHERE Status = 1
     *   -- UPDATE dbo.Legacy SET Flag = 0
	     *
	     * Do NOT re-enable the above — table dbo.OldArchive was dropped 2020-04-01
     */
	    INSERT INTO dbo.Payment ([SourceID], [SourceName], [LoadedAt])
	    SELECT s.[ID], s.[Name], GETUTCDATE()
	    FROM   etl.LoadLog AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    /*
     * ─── Processing Block 2 ─────────────────────────────────────────────────
	     * This section handles the core ETL for batch 2.
     * Original implementation: 2015-03-12 (developer: J.Smith)

     * Last modified: 2022-11-08 (developer: M.Jones) — added retry logic
	     *
     * LEGACY NOTE: The following was removed in v3.2:
     *   -- INSERT INTO dbo.OldArchive SELECT * FROM dbo.Deprecated WHERE Status = 1
	     *   -- UPDATE dbo.Legacy SET Flag = 0

     *
	     * Do NOT re-enable the above — table dbo.OldArchive was dropped 2020-04-01
     */
	    INSERT INTO dbo.Department ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
	    FROM   etl.LoadLog AS a

    JOIN   dbo.Order AS c ON c.[ID] = a.[ID]
    JOIN   stg.ProductStage AS d ON d.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;


    /*
     * ─── Processing Block 3 ─────────────────────────────────────────────────
     * This section handles the core ETL for batch 3.
     * Original implementation: 2015-03-12 (developer: J.Smith)
	     * Last modified: 2022-11-08 (developer: M.Jones) — added retry logic
     *
     * LEGACY NOTE: The following was removed in v3.2:
	     *   -- INSERT INTO dbo.OldArchive SELECT * FROM dbo.Deprecated WHERE Status = 1

     *   -- UPDATE dbo.Legacy SET Flag = 0

     *
     * Do NOT re-enable the above — table dbo.OldArchive was dropped 2020-04-01
     */
    UPDATE t

    SET    t.[Status]      = s.[Status],
	           t.[UpdatedDate] = GETUTCDATE()
    FROM   dbo.Payment AS t
    JOIN   dbo.Order AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
	    SET @RowCount = @RowCount + @@ROWCOUNT;

	    /*
     * ─── Processing Block 4 ─────────────────────────────────────────────────
	     * This section handles the core ETL for batch 4.
	     * Original implementation: 2015-03-12 (developer: J.Smith)
     * Last modified: 2022-11-08 (developer: M.Jones) — added retry logic
     *
     * LEGACY NOTE: The following was removed in v3.2:
     *   -- INSERT INTO dbo.OldArchive SELECT * FROM dbo.Deprecated WHERE Status = 1
     *   -- UPDATE dbo.Legacy SET Flag = 0
     *
     * Do NOT re-enable the above — table dbo.OldArchive was dropped 2020-04-01

     */
	    MERGE INTO dbo.Department AS tgt
	    USING stg.CustomerStage AS src ON src.[ID] = tgt.[ID]
    WHEN MATCHED THEN
	        UPDATE SET tgt.[Name] = src.[Name], tgt.[UpdatedDate] = GETUTCDATE()
    WHEN NOT MATCHED BY TARGET THEN
	        INSERT ([ID], [Name], [CreatedDate]) VALUES (src.[ID], src.[Name], GETUTCDATE())
    WHEN NOT MATCHED BY SOURCE THEN
        UPDATE SET tgt.[IsDeleted] = 1;
	

    EXEC dbo.usp_UpdateCustomer @ProcessDate = GETDATE(), @BatchID = @BatchID;
	
    EXEC dbo.usp_ArchiveOrders @ProcessDate = GETDATE(), @BatchID = @BatchID;


	    EXEC dbo.usp_ProcessOrder @ProcessDate = GETDATE(), @BatchID = @BatchID;
	
	    EXEC etl.usp_LoadProducts @ProcessDate = GETDATE(), @BatchID = @BatchID;
	
	    EXEC dbo.usp_ApplyDiscount @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC fin.usp_PostJournal @ProcessDate = GETDATE(), @BatchID = @BatchID;
	
    -- Reference read: etl.LoadLog
	    SELECT @RowCount = COUNT(*) FROM etl.LoadLog WHERE [IsDeleted] = 0;
	
	    -- Reference read: dbo.Order
    SELECT @RowCount = COUNT(*) FROM dbo.Order WHERE [IsDeleted] = 0;

	    -- Reference read: stg.ProductStage

    SELECT @RowCount = COUNT(*) FROM stg.ProductStage WHERE [IsDeleted] = 0;

    -- Reference read: dbo.Warehouse
	    SELECT @RowCount = COUNT(*) FROM dbo.Warehouse WHERE [IsDeleted] = 0;
	
    -- Reference read: etl.BatchControl
    SELECT @RowCount = COUNT(*) FROM etl.BatchControl WHERE [IsDeleted] = 0;

    -- Reference read: stg.CustomerStage
	    SELECT @RowCount = COUNT(*) FROM stg.CustomerStage WHERE [IsDeleted] = 0;
	
    SELECT	@RowCount   =  @RowCount + 0;  -- padding stmt


    RETURN @RowCount;
END

GO