-- GENERATED SP 63: tier=medium flags=[variableTableHeavy,tempTableHeavy]
-- EXPECT  sources:[dbo].[Customer],[dbo].[Department],[stg].[PaymentStage]  targets:[hr].[Performance]  exec:[etl].[usp_LoadCustomers]

CREATE PROCEDURE [hr].[usp_GenMedium_063]
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

    -- Pre-stage data in temp tables
    CREATE TABLE #WorkSet ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2), [ProcessedAt] DATETIME);
    INSERT INTO #WorkSet ([ID], [Name], [Amount], [ProcessedAt])
    SELECT [ID], [Name], ISNULL([Amount], 0), GETUTCDATE()
    FROM   [dbo].[Customer]
    WHERE  [IsDeleted] = 0;
    CREATE TABLE #RefData ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2), [ProcessedAt] DATETIME);
    INSERT INTO #RefData ([ID], [Name], [Amount], [ProcessedAt])
    SELECT [ID], [Name], ISNULL([Amount], 0), GETUTCDATE()
    FROM   [dbo].[Department]
    WHERE  [IsDeleted] = 0;

    INSERT INTO hr.Performance ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [dbo].[Customer] AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   [hr].[Performance] AS t
    JOIN   [dbo].[Department] AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC etl.usp_LoadCustomers @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [dbo].[Customer]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Customer] WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[Department]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Department] WHERE [IsDeleted] = 0;

    -- Reference read: stg.PaymentStage
    SELECT @RowCount = COUNT(*) FROM stg.PaymentStage WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO