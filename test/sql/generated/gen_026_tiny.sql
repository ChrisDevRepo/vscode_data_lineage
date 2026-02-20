-- GENERATED SP 26: tier=tiny flags=[bracketedEverything]
-- EXPECT  sources:[hr].[LeaveRequest],[dbo].[Invoice]  targets:[stg].[EmployeeStage]  exec:[dbo].[usp_GenerateInvoice]

CREATE PROCEDURE [etl].[usp_GenTiny_026]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    INSERT INTO [stg].[EmployeeStage] ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [hr].[LeaveRequest] AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC [dbo].[usp_GenerateInvoice] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [hr].[LeaveRequest]
    SELECT @RowCount = COUNT(*) FROM [hr].[LeaveRequest] WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[Invoice]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Invoice] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO