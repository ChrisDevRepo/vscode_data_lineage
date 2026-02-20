-- GENERATED SP 74: tier=medium flags=[variableTableHeavy,noBrackets]
-- EXPECT  sources:[hr].[Department],[dbo].[Invoice]  targets:[dbo].[Customer]  exec:[dbo].[usp_UpdateCustomer],[fin].[usp_PostJournal],[etl].[usp_LoadProducts]

CREATE PROCEDURE [fin].[usp_GenMedium_074]
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

    INSERT INTO dbo.Customer ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   hr.Department AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   dbo.Customer AS t
    JOIN   dbo.Invoice AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC dbo.usp_UpdateCustomer @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC fin.usp_PostJournal @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC etl.usp_LoadProducts @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: hr.Department
    SELECT @RowCount = COUNT(*) FROM hr.Department WHERE [IsDeleted] = 0;

    -- Reference read: dbo.Invoice
    SELECT @RowCount = COUNT(*) FROM dbo.Invoice WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO