-- GENERATED SP 118: tier=medium flags=[nestedSubqueries,weirdWhitespace]
-- EXPECT  sources:[dbo].[Customer],[dbo].[Department],[ops].[Inventory]  targets:[dbo].[Account]  exec:[dbo].[usp_ProcessOrder]


	CREATE PROCEDURE [hr].[usp_GenMedium_118]
	    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
	    DECLARE @StartTime DATETIME = GETUTCDATE();
	

    INSERT INTO dbo.Account ([ID], [Name])
    SELECT x.[ID], x.[Name]
    FROM (

        SELECT i.[ID], i.[Name], ROW_NUMBER() OVER (ORDER BY i.[UpdatedDate] DESC) AS rn
        FROM (
            SELECT [ID], [Name], [UpdatedDate]
            FROM   [dbo].[Customer]
            WHERE  [IsDeleted] = 0
	        ) AS i

    ) AS x

    WHERE x.rn = 1;
    SET @RowCount = @RowCount + @@ROWCOUNT;
	
    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   dbo.Account AS t
    JOIN   [dbo].[Department] AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
	    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC dbo.usp_ProcessOrder @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [dbo].[Customer]
	    SELECT @RowCount = COUNT(*) FROM dbo.Customer WHERE [IsDeleted] = 0;
	

    -- Reference read: dbo.Department
	    SELECT @RowCount = COUNT(*) FROM dbo.Department WHERE [IsDeleted] = 0;


	    -- Reference read: ops.Inventory
	    SELECT @RowCount = COUNT(*) FROM ops.Inventory WHERE [IsDeleted] = 0;

    SELECT	@RowCount   =  @RowCount + 0;  -- padding stmt


    RETURN @RowCount;
END
GO