-- GENERATED SP 32: tier=tiny flags=[massiveComments]
-- EXPECT  sources:[dbo].[Employee]  targets:[hr].[Employee]  exec:[dbo].[usp_UpdateCustomer]

CREATE PROCEDURE [ops].[usp_GenTiny_032]
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
    INSERT INTO [hr].[Employee] ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   dbo.Employee AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC [dbo].[usp_UpdateCustomer] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: dbo.Employee
    SELECT @RowCount = COUNT(*) FROM [dbo].[Employee] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO