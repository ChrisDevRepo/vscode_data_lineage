-- GENERATED SP 136: tier=medium flags=[bracketedEverything,weirdWhitespace]
-- EXPECT  sources:[rpt].[EmployeePerf],[etl].[ErrorLog],[dbo].[Transaction],[dbo].[OrderLine]  targets:[rpt].[MonthlyOrders]  exec:[dbo].[usp_UpdateCustomer],[dbo].[usp_ProcessOrder]

CREATE PROCEDURE [dbo].[usp_GenMedium_136]
	    @BatchID    INT = 0,

    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    INSERT INTO [rpt].[MonthlyOrders] ([SourceID], [SourceName], [LoadedAt])

    SELECT s.[ID], s.[Name], GETUTCDATE()
	    FROM   [rpt].[EmployeePerf] AS s
	    WHERE  s.[IsDeleted] = 0;

    SET @RowCount = @RowCount + @@ROWCOUNT;

    UPDATE t

    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   [rpt].[MonthlyOrders] AS t

    JOIN   [etl].[ErrorLog] AS s ON s.[ID] = t.[SourceID]

    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC [dbo].[usp_UpdateCustomer] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [dbo].[usp_ProcessOrder] @ProcessDate = GETDATE(), @BatchID = @BatchID;
	

    -- Reference read: [rpt].[EmployeePerf]
    SELECT @RowCount = COUNT(*) FROM [rpt].[EmployeePerf] WHERE [IsDeleted] = 0;

    -- Reference read: [etl].[ErrorLog]
    SELECT @RowCount = COUNT(*) FROM [etl].[ErrorLog] WHERE [IsDeleted] = 0;

	    -- Reference read: [dbo].[Transaction]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Transaction] WHERE [IsDeleted] = 0;
	
    -- Reference read: [dbo].[OrderLine]
    SELECT @RowCount = COUNT(*) FROM [dbo].[OrderLine] WHERE [IsDeleted] = 0;

	    SELECT	@RowCount   =  @RowCount + 0;  -- padding stmt

    RETURN @RowCount;
END
	GO