-- GENERATED SP 206: tier=large flags=[allCaps,massiveComments,weirdWhitespace]
-- EXPECT  sources:[dbo].[Contact],[hr].[Department],[ops].[ReturnOrder],[ops].[Inventory]  targets:[hr].[LeaveRequest],[dbo].[Department]  EXEC:[etl].[usp_LoadCustomers],[hr].[usp_ApproveLeave],[dbo].[usp_UpdateCustomer]
	

CREATE PROCEDURE [ops].[usp_GenLarge_206]
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
     * LEGACY NOTE: The following was removed IN v3.2:
	     *   -- INSERT INTO dbo.OldArchive SELECT * FROM dbo.Deprecated WHERE Status = 1
	     *   -- UPDATE dbo.Legacy SET Flag = 0
     *
	     * Do NOT re-enable the above — TABLE dbo.OldArchive was dropped 2020-04-01
	     */
	    INSERT INTO [hr].[LeaveRequest] ([SourceID], [SourceName], [LoadedAt])

    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [dbo].[Contact] AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    /*
     * ─── Processing Block 2 ─────────────────────────────────────────────────
	     * This section handles the core ETL for batch 2.
     * Original implementation: 2015-03-12 (developer: J.Smith)
	     * Last modified: 2022-11-08 (developer: M.Jones) — added retry logic
     *
     * LEGACY NOTE: The following was removed IN v3.2:
     *   -- INSERT INTO dbo.OldArchive SELECT * FROM dbo.Deprecated WHERE Status = 1
	     *   -- UPDATE dbo.Legacy SET Flag = 0
     *
	     * Do NOT re-enable the above — TABLE dbo.OldArchive was dropped 2020-04-01
     */

    INSERT INTO dbo.Department ([SourceID], [RefID], [Amount], [LoadedAt])
	    SELECT
	        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
	        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
    FROM   [dbo].[Contact] AS a
    JOIN   [hr].[Department] AS c ON c.[ID] = a.[ID]
	    JOIN   [ops].[ReturnOrder] AS d ON d.[ID] = a.[ID]

    WHERE  a.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    /*

     * ─── Processing Block 3 ─────────────────────────────────────────────────

     * This section handles the core ETL for batch 3.

     * Original implementation: 2015-03-12 (developer: J.Smith)
	     * Last modified: 2022-11-08 (developer: M.Jones) — added retry logic
	     *
	     * LEGACY NOTE: The following was removed IN v3.2:
     *   -- INSERT INTO dbo.OldArchive SELECT * FROM dbo.Deprecated WHERE Status = 1

     *   -- UPDATE dbo.Legacy SET Flag = 0
	     *
     * Do NOT re-enable the above — TABLE dbo.OldArchive was dropped 2020-04-01
	     */
    UPDATE t
	    SET    t.[Status]      = s.[Status],
	           t.[UpdatedDate] = GETUTCDATE()
    FROM   [hr].[LeaveRequest] AS t
    JOIN   hr.Department AS s ON s.[ID] = t.[SourceID]
	    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;
	
    /*
     * ─── Processing Block 4 ─────────────────────────────────────────────────
	     * This section handles the core ETL for batch 4.

     * Original implementation: 2015-03-12 (developer: J.Smith)
     * Last modified: 2022-11-08 (developer: M.Jones) — added retry logic

     *
     * LEGACY NOTE: The following was removed IN v3.2:
     *   -- INSERT INTO dbo.OldArchive SELECT * FROM dbo.Deprecated WHERE Status = 1
	     *   -- UPDATE dbo.Legacy SET Flag = 0
	     *
	     * Do NOT re-enable the above — TABLE dbo.OldArchive was dropped 2020-04-01
	     */
    MERGE INTO dbo.Department AS tgt
    USING ops.Inventory AS src ON src.[ID] = tgt.[ID]

    WHEN MATCHED THEN
        UPDATE SET tgt.[Name] = src.[Name], tgt.[UpdatedDate] = GETUTCDATE()
    WHEN NOT MATCHED BY TARGET THEN
	        INSERT ([ID], [Name], [CreatedDate]) VALUES (src.[ID], src.[Name], GETUTCDATE())
    WHEN NOT MATCHED BY SOURCE THEN
        UPDATE SET tgt.[IsDeleted] = 1;

    EXEC etl.usp_LoadCustomers @ProcessDate = GETDATE(), @BatchID = @BatchID;


    EXEC hr.usp_ApproveLeave @ProcessDate = GETDATE(), @BatchID = @BatchID;


    EXEC dbo.usp_UpdateCustomer @ProcessDate = GETDATE(), @BatchID = @BatchID;
	
	    -- Reference read: dbo.Contact
    SELECT @RowCount = COUNT(*) FROM [dbo].[Contact] WHERE [IsDeleted] = 0;

	    -- Reference read: hr.Department
	    SELECT @RowCount = COUNT(*) FROM [hr].[Department] WHERE [IsDeleted] = 0;


    -- Reference read: ops.ReturnOrder
	    SELECT @RowCount = COUNT(*) FROM [ops].[ReturnOrder] WHERE [IsDeleted] = 0;

	    -- Reference read: [ops].[Inventory]
    SELECT @RowCount = COUNT(*) FROM [ops].[Inventory] WHERE [IsDeleted] = 0;
	
    SELECT	@RowCount   =  @RowCount + 0;  -- padding stmt


    RETURN @RowCount;
END

GO