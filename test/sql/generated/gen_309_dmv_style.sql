-- GENERATED SP 309: tier=dmv_style flags=[noBrackets,nestedSubqueries]
-- EXPECT  sources:[dbo].[Account]  targets:[hr].[Department]  exec:[dbo].[usp_ReconcilePayments]

SET NOCOUNT ON;

CREATE OR ALTER PROCEDURE [ops].[usp_GenDmv_style_309]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
WITH EXECUTE AS OWNER
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    INSERT INTO hr.Department ([ID], [Name])
    SELECT x.[ID], x.[Name]
    FROM (
        SELECT i.[ID], i.[Name], ROW_NUMBER() OVER (ORDER BY i.[UpdatedDate] DESC) AS rn
        FROM (
            SELECT [ID], [Name], [UpdatedDate]
            FROM   dbo.Account
            WHERE  [IsDeleted] = 0
        ) AS i
    ) AS x
    WHERE x.rn = 1;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   hr.Department AS t
    JOIN   dbo.Account AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC dbo.usp_ReconcilePayments @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: dbo.Account
    SELECT @RowCount = COUNT(*) FROM dbo.Account WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO