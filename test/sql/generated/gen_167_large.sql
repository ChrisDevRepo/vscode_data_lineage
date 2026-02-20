-- GENERATED SP 167: tier=large flags=[massiveComments,noBrackets,nestedSubqueries]
-- EXPECT  sources:[rpt].[CustomerChurn],[dbo].[Address],[stg].[PaymentStage],[dbo].[PriceList],[stg].[CustomerStage],[rpt].[EmployeePerf]  targets:[stg].[OrderStage],[fin].[Budget],[rpt].[RegionMetrics]  exec:[audit].[usp_LogChange],[dbo].[usp_UpdateCustomer]

CREATE PROCEDURE [dbo].[usp_GenLarge_167]
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
    INSERT INTO stg.OrderStage ([ID], [Name])
    SELECT x.[ID], x.[Name]
    FROM (
        SELECT i.[ID], i.[Name], ROW_NUMBER() OVER (ORDER BY i.[UpdatedDate] DESC) AS rn
        FROM (
            SELECT [ID], [Name], [UpdatedDate]
            FROM   rpt.CustomerChurn
            WHERE  [IsDeleted] = 0
        ) AS i
    ) AS x
    WHERE x.rn = 1;
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
    INSERT INTO fin.Budget ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
    FROM   rpt.CustomerChurn AS a
    JOIN   dbo.Address AS c ON c.[ID] = a.[ID]
    JOIN   stg.PaymentStage AS d ON d.[ID] = a.[ID]
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
    INSERT INTO rpt.RegionMetrics ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
    FROM   rpt.CustomerChurn AS a
    JOIN   dbo.Address AS c ON c.[ID] = a.[ID]
    JOIN   stg.PaymentStage AS d ON d.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
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
    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   stg.OrderStage AS t
    JOIN   dbo.Address AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    /*
     * ─── Processing Block 5 ─────────────────────────────────────────────────
     * This section handles the core ETL for batch 5.
     * Original implementation: 2015-03-12 (developer: J.Smith)
     * Last modified: 2022-11-08 (developer: M.Jones) — added retry logic
     *
     * LEGACY NOTE: The following was removed in v3.2:
     *   -- INSERT INTO dbo.OldArchive SELECT * FROM dbo.Deprecated WHERE Status = 1
     *   -- UPDATE dbo.Legacy SET Flag = 0
     *
     * Do NOT re-enable the above — table dbo.OldArchive was dropped 2020-04-01
     */
    MERGE INTO rpt.RegionMetrics AS tgt
    USING rpt.EmployeePerf AS src ON src.[ID] = tgt.[ID]
    WHEN MATCHED THEN
        UPDATE SET tgt.[Name] = src.[Name], tgt.[UpdatedDate] = GETUTCDATE()
    WHEN NOT MATCHED BY TARGET THEN
        INSERT ([ID], [Name], [CreatedDate]) VALUES (src.[ID], src.[Name], GETUTCDATE())
    WHEN NOT MATCHED BY SOURCE THEN
        UPDATE SET tgt.[IsDeleted] = 1;

    EXEC audit.usp_LogChange @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC dbo.usp_UpdateCustomer @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: rpt.CustomerChurn
    SELECT @RowCount = COUNT(*) FROM rpt.CustomerChurn WHERE [IsDeleted] = 0;

    -- Reference read: dbo.Address
    SELECT @RowCount = COUNT(*) FROM dbo.Address WHERE [IsDeleted] = 0;

    -- Reference read: stg.PaymentStage
    SELECT @RowCount = COUNT(*) FROM stg.PaymentStage WHERE [IsDeleted] = 0;

    -- Reference read: dbo.PriceList
    SELECT @RowCount = COUNT(*) FROM dbo.PriceList WHERE [IsDeleted] = 0;

    -- Reference read: stg.CustomerStage
    SELECT @RowCount = COUNT(*) FROM stg.CustomerStage WHERE [IsDeleted] = 0;

    -- Reference read: rpt.EmployeePerf
    SELECT @RowCount = COUNT(*) FROM rpt.EmployeePerf WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO