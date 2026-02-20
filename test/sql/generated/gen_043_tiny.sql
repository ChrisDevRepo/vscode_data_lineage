-- GENERATED SP 43: tier=tiny flags=[bracketedEverything]
-- EXPECT  sources:[dbo].[Address]  targets:[hr].[Employee]  exec:

CREATE PROCEDURE [etl].[usp_GenTiny_043]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    INSERT INTO [hr].[Employee] ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [dbo].[Address] AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    -- Reference read: [dbo].[Address]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Address] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO