-- GENERATED SP 44: tier=tiny flags=[variableTableHeavy]
-- EXPECT  sources:[etl].[LoadLog],[dbo].[Region]  targets:[dbo].[Shipper]  exec:[dbo].[usp_ProcessOrder]

CREATE PROCEDURE [hr].[usp_GenTiny_044]
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

    INSERT INTO dbo.Shipper ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   etl.LoadLog AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC dbo.usp_ProcessOrder @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [etl].[LoadLog]
    SELECT @RowCount = COUNT(*) FROM [etl].[LoadLog] WHERE [IsDeleted] = 0;

    -- Reference read: dbo.Region
    SELECT @RowCount = COUNT(*) FROM dbo.Region WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO