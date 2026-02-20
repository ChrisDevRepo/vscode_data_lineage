-- GENERATED SP 2: tier=tiny flags=[printStatements]
-- EXPECT  sources:[dbo].[Order]  targets:[dbo].[Transaction]  exec:[etl].[usp_LoadCustomers]

CREATE PROCEDURE [fin].[usp_GenTiny_002]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    INSERT INTO dbo.Transaction ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   dbo.Order AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    PRINT N'Step 1: Processing batch @BatchID = ' + CAST(@BatchID AS NVARCHAR) + N', elapsed: ' + CAST(DATEDIFF(ms, @StartTime, GETUTCDATE()) AS NVARCHAR) + N' ms';

    EXEC [etl].[usp_LoadCustomers] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [dbo].[Order]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Order] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO