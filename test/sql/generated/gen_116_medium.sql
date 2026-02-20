-- GENERATED SP 116: tier=medium flags=[weirdWhitespace,excessiveDeclare]
-- EXPECT  sources:[dbo].[OrderLine],[fin].[Transaction],[etl].[BatchControl]  targets:[rpt].[CustomerChurn],[etl].[ExtractLog]  exec:[fin].[usp_PostJournal]

	CREATE PROCEDURE [dbo].[usp_GenMedium_116]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL

AS
BEGIN
	    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @BatchID INT = 0;
    DECLARE @ProcessDate DATETIME = GETDATE();
	    DECLARE @RowCount INT;
    DECLARE @ErrorMessage NVARCHAR(4000);

    DECLARE @ErrorSeverity INT;
    DECLARE @ErrorState INT;
    DECLARE @RetryCount INT = 0;
    DECLARE @MaxRetries INT = 3;
    DECLARE @StartTime DATETIME = GETUTCDATE();
    DECLARE @EndTime DATETIME;
    DECLARE @DebugMode BIT = 0;

    DECLARE @SchemaVersion NVARCHAR(20) = N'1.0';
    DECLARE @ProcName NVARCHAR(128) = OBJECT_NAME(@@PROCID);
	    DECLARE @AppName NVARCHAR(128) = APP_NAME();
	    DECLARE @HostName NVARCHAR(128) = HOST_NAME();
	    DECLARE @UserName NVARCHAR(128) = SUSER_SNAME();
	    DECLARE @DBName NVARCHAR(128) = DB_NAME();

    DECLARE @ServerName NVARCHAR(128) = @@SERVERNAME;
    DECLARE @SPID INT = @@SPID;
	    DECLARE @NestLevel INT = @@NESTLEVEL;
	
    INSERT INTO [rpt].[CustomerChurn] ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
	    FROM   [dbo].[OrderLine] AS s
    WHERE  s.[IsDeleted] = 0;

    SET @RowCount = @RowCount + @@ROWCOUNT;

    INSERT INTO etl.ExtractLog ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
	        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt

    FROM   dbo.OrderLine AS a
    JOIN   fin.Transaction AS c ON c.[ID] = a.[ID]
    JOIN   etl.BatchControl AS d ON d.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;
	
    UPDATE t
	    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   [rpt].[CustomerChurn] AS t
    JOIN   fin.Transaction AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;


    EXEC fin.usp_PostJournal @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [dbo].[OrderLine]
	    SELECT @RowCount = COUNT(*) FROM [dbo].[OrderLine] WHERE [IsDeleted] = 0;

	    -- Reference read: fin.Transaction
	    SELECT @RowCount = COUNT(*) FROM [fin].[Transaction] WHERE [IsDeleted] = 0;
	
	    -- Reference read: etl.BatchControl
    SELECT @RowCount = COUNT(*) FROM etl.BatchControl WHERE [IsDeleted] = 0;
	
    SELECT	@RowCount   =  @RowCount + 0;  -- padding stmt

	    RETURN @RowCount;

END
GO