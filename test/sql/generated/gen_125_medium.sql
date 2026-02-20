-- GENERATED SP 125: tier=medium flags=[noBrackets,allCaps]
-- EXPECT  sources:[dbo].[TRANSACTION],[rpt].[EmployeePerf]  targets:[dbo].[Contact]  EXEC:[dbo].[usp_GenerateInvoice]

CREATE PROCEDURE [fin].[usp_GenMedium_125]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    INSERT INTO dbo.Contact ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   dbo.TRANSACTION AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   dbo.Contact AS t
    JOIN   rpt.EmployeePerf AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC dbo.usp_GenerateInvoice @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: dbo.TRANSACTION
    SELECT @RowCount = COUNT(*) FROM dbo.TRANSACTION WHERE [IsDeleted] = 0;

    -- Reference read: rpt.EmployeePerf
    SELECT @RowCount = COUNT(*) FROM rpt.EmployeePerf WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO