-- GENERATED SP 84: tier=medium flags=[nestedSubqueries,printStatements]
-- EXPECT  sources:[stg].[OrderStage],[stg].[PaymentStage]  targets:[dbo].[Payment]  exec:[etl].[usp_ValidateStage],[etl].[usp_LoadCustomers],[hr].[usp_ApproveLeave]

CREATE PROCEDURE [dbo].[usp_GenMedium_084]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    INSERT INTO dbo.Payment ([ID], [Name])
    SELECT x.[ID], x.[Name]
    FROM (
        SELECT i.[ID], i.[Name], ROW_NUMBER() OVER (ORDER BY i.[UpdatedDate] DESC) AS rn
        FROM (
            SELECT [ID], [Name], [UpdatedDate]
            FROM   [stg].[OrderStage]
            WHERE  [IsDeleted] = 0
        ) AS i
    ) AS x
    WHERE x.rn = 1;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    PRINT N'Step 1: Processing batch @BatchID = ' + CAST(@BatchID AS NVARCHAR) + N', elapsed: ' + CAST(DATEDIFF(ms, @StartTime, GETUTCDATE()) AS NVARCHAR) + N' ms';

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   dbo.Payment AS t
    JOIN   stg.PaymentStage AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC etl.usp_ValidateStage @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [etl].[usp_LoadCustomers] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [hr].[usp_ApproveLeave] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [stg].[OrderStage]
    SELECT @RowCount = COUNT(*) FROM [stg].[OrderStage] WHERE [IsDeleted] = 0;

    -- Reference read: stg.PaymentStage
    SELECT @RowCount = COUNT(*) FROM stg.PaymentStage WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO