-- GENERATED SP 145: tier=medium flags=[bracketedEverything,variableTableHeavy]
-- EXPECT  sources:[dbo].[PriceList],[rpt].[SalesSummary]  targets:[hr].[Department],[dbo].[Product]  exec:[fin].[usp_PostJournal],[etl].[usp_LoadCustomers],[dbo].[usp_ReconcilePayments]

CREATE PROCEDURE [hr].[usp_GenMedium_145]
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

    INSERT INTO [hr].[Department] ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [dbo].[PriceList] AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    INSERT INTO [dbo].[Product] ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
    FROM   [dbo].[PriceList] AS a
    JOIN   [rpt].[SalesSummary] AS c ON c.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   [hr].[Department] AS t
    JOIN   [rpt].[SalesSummary] AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC [fin].[usp_PostJournal] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [etl].[usp_LoadCustomers] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [dbo].[usp_ReconcilePayments] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [dbo].[PriceList]
    SELECT @RowCount = COUNT(*) FROM [dbo].[PriceList] WHERE [IsDeleted] = 0;

    -- Reference read: [rpt].[SalesSummary]
    SELECT @RowCount = COUNT(*) FROM [rpt].[SalesSummary] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO