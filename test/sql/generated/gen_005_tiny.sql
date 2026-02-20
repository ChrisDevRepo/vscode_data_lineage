-- GENERATED SP 5: tier=tiny flags=[variableTableHeavy]
-- EXPECT  sources:[dbo].[Order]  targets:[dbo].[Customer]  exec:

CREATE PROCEDURE [rpt].[usp_GenTiny_005]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    DECLARE @TempBuffer TABLE ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2));
    -- @table variable populated from logic above — not a catalog dependency
    DECLARE @StagingRows TABLE ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2));
    -- @table variable populated from logic above — not a catalog dependency

    INSERT INTO [dbo].[Customer] ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [dbo].[Order] AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    -- Reference read: [dbo].[Order]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Order] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO