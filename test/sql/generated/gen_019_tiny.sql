-- GENERATED SP 19: tier=tiny flags=[nestedSubqueries]
-- EXPECT  sources:[dbo].[Invoice],[dbo].[Region]  targets:[hr].[LeaveRequest]  exec:[rpt].[usp_RefreshSummary]

CREATE PROCEDURE [fin].[usp_GenTiny_019]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    INSERT INTO hr.LeaveRequest ([ID], [Name])
    SELECT x.[ID], x.[Name]
    FROM (
        SELECT i.[ID], i.[Name], ROW_NUMBER() OVER (ORDER BY i.[UpdatedDate] DESC) AS rn
        FROM (
            SELECT [ID], [Name], [UpdatedDate]
            FROM   dbo.Invoice
            WHERE  [IsDeleted] = 0
        ) AS i
    ) AS x
    WHERE x.rn = 1;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC [rpt].[usp_RefreshSummary] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [dbo].[Invoice]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Invoice] WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[Region]
    SELECT @RowCount = COUNT(*) FROM dbo.Region WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO