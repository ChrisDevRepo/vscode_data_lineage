-- GENERATED SP 25: tier=tiny flags=[transactionBlocks]
-- EXPECT  sources:[dbo].[Order]  targets:[dbo].[Region]  exec:[rpt].[usp_RefreshSummary]

CREATE PROCEDURE [etl].[usp_GenTiny_025]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    BEGIN TRANSACTION;
    INSERT INTO [dbo].[Region] ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   dbo.Order AS s
    WHERE  s.[IsDeleted] = 0;
    IF @@ERROR = 0
        COMMIT TRANSACTION;
    ELSE
        ROLLBACK TRANSACTION;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC [rpt].[usp_RefreshSummary] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [dbo].[Order]
    SELECT @RowCount = COUNT(*) FROM dbo.Order WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO