-- GENERATED SP 16: tier=tiny flags=[allCaps]
-- EXPECT  sources:[hr].[Employee],[dbo].[Employee]  targets:[dbo].[Invoice]  EXEC:

CREATE PROCEDURE [etl].[usp_GenTiny_016]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    INSERT INTO [dbo].[Invoice] ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [hr].[Employee] AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    -- Reference read: hr.Employee
    SELECT @RowCount = COUNT(*) FROM hr.Employee WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[Employee]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Employee] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO