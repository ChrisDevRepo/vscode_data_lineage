-- GENERATED SP 41: tier=tiny flags=[transactionBlocks]
-- EXPECT  sources:[dbo].[OrderLine]  targets:[dbo].[SalesTarget]  exec:[dbo].[usp_ApplyDiscount]

CREATE PROCEDURE [dbo].[usp_GenTiny_041]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    BEGIN TRANSACTION;
    INSERT INTO dbo.SalesTarget ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [dbo].[OrderLine] AS s
    WHERE  s.[IsDeleted] = 0;
    IF @@ERROR = 0
        COMMIT TRANSACTION;
    ELSE
        ROLLBACK TRANSACTION;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC dbo.usp_ApplyDiscount @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: dbo.OrderLine
    SELECT @RowCount = COUNT(*) FROM [dbo].[OrderLine] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO