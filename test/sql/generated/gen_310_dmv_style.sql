-- GENERATED SP 310: tier=dmv_style flags=[variableTableHeavy,weirdWhitespace]
-- EXPECT  sources:[dbo].[Customer],[dbo].[Account],[hr].[LeaveRequest],[dbo].[Warehouse]  targets:[dbo].[Payment],[dbo].[Contact]  exec:
	
SET NOCOUNT ON;

	CREATE OR ALTER PROCEDURE [rpt].[usp_GenDmv_style_310]
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


	    DECLARE @TempBuffer TABLE ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2));

    -- @table variable populated from logic above — not a catalog dependency
	    DECLARE @StagingRows TABLE ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2));

    -- @table variable populated from logic above — not a catalog dependency


    INSERT INTO [dbo].[Payment] ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [dbo].[Customer] AS s
    WHERE  s.[IsDeleted] = 0;
	    SET @RowCount = @RowCount + @@ROWCOUNT;


    INSERT INTO [dbo].[Contact] ([SourceID], [RefID], [Amount], [LoadedAt])

    SELECT
        a.[ID]          AS SourceID,
	        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
    FROM   [dbo].[Customer] AS a
    JOIN   dbo.Account AS c ON c.[ID] = a.[ID]
    JOIN   [hr].[LeaveRequest] AS d ON d.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;
	
    UPDATE t
	    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
	    FROM   dbo.Payment AS t

    JOIN   [dbo].[Account] AS s ON s.[ID] = t.[SourceID]
	    WHERE  t.[Status] = N'PENDING';

    SET @RowCount = @RowCount + @@ROWCOUNT;

    -- Reference read: dbo.Customer

    SELECT @RowCount = COUNT(*) FROM dbo.Customer WHERE [IsDeleted] = 0;


	    -- Reference read: [dbo].[Account]
    SELECT @RowCount = COUNT(*) FROM dbo.Account WHERE [IsDeleted] = 0;
	
	    -- Reference read: hr.LeaveRequest
    SELECT @RowCount = COUNT(*) FROM [hr].[LeaveRequest] WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[Warehouse]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Warehouse] WHERE [IsDeleted] = 0;


    SELECT	@RowCount   =  @RowCount + 0;  -- padding stmt
	
    RETURN @RowCount;
END
GO