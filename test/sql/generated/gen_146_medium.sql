-- GENERATED SP 146: tier=medium flags=[nestedSubqueries,allCaps]
-- EXPECT  sources:[stg].[EmployeeStage],[dbo].[Account],[dbo].[Contact],[dbo].[Customer]  targets:[dbo].[Warehouse]  EXEC:[etl].[usp_LoadOrders]

CREATE PROCEDURE [ops].[usp_GenMedium_146]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    INSERT INTO dbo.Warehouse ([ID], [Name])
    SELECT x.[ID], x.[Name]
    FROM (
        SELECT i.[ID], i.[Name], ROW_NUMBER() OVER (ORDER BY i.[UpdatedDate] DESC) AS rn
        FROM (
            SELECT [ID], [Name], [UpdatedDate]
            FROM   stg.EmployeeStage
            WHERE  [IsDeleted] = 0
        ) AS i
    ) AS x
    WHERE x.rn = 1;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   dbo.Warehouse AS t
    JOIN   [dbo].[Account] AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC [etl].[usp_LoadOrders] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: stg.EmployeeStage
    SELECT @RowCount = COUNT(*) FROM stg.EmployeeStage WHERE [IsDeleted] = 0;

    -- Reference read: dbo.Account
    SELECT @RowCount = COUNT(*) FROM [dbo].[Account] WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[Contact]
    SELECT @RowCount = COUNT(*) FROM dbo.Contact WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[Customer]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Customer] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO