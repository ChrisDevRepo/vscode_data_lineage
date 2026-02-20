-- GENERATED SP 162: tier=large flags=[commentedOutSQL,weirdWhitespace,excessiveDeclare]
-- EXPECT  sources:[dbo].[Employee],[dbo].[SalesTarget],[audit].[AccessLog],[rpt].[CustomerChurn],[fin].[Budget]  targets:[fin].[Transaction],[stg].[CustomerStage]  exec:[dbo].[usp_UpdateCustomer],[dbo].[usp_ProcessOrder],[etl].[usp_LoadProducts],[fin].[usp_PostJournal],[etl].[usp_ValidateStage]

CREATE PROCEDURE [rpt].[usp_GenLarge_162]
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
	
    -- OLD CODE (removed 2019-06-15) — kept for reference:
    -- INSERT INTO dbo.DeprecatedLog (EntityID, Action, LogDate)

    -- SELECT ID, N'PROCESS', GETDATE() FROM dbo.OldLegacyTable WHERE Status = 0
	    -- UPDATE dbo.OldFlag SET Active = 0 WHERE ProcessDate < '2019-01-01'
    -- EXEC dbo.usp_OldArchive @cutoff = '2019-01-01'


    INSERT INTO fin.Transaction ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [dbo].[Employee] AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    INSERT INTO [stg].[CustomerStage] ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
	        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
	        GETUTCDATE()    AS LoadedAt
    FROM   [dbo].[Employee] AS a
    JOIN   dbo.SalesTarget AS c ON c.[ID] = a.[ID]
    JOIN   [audit].[AccessLog] AS d ON d.[ID] = a.[ID]

    WHERE  a.[Status] = N'PENDING';
	    SET @RowCount = @RowCount + @@ROWCOUNT;

	    UPDATE t
	    SET    t.[Status]      = s.[Status],

           t.[UpdatedDate] = GETUTCDATE()
    FROM   [fin].[Transaction] AS t

    JOIN   [dbo].[SalesTarget] AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
	    SET @RowCount = @RowCount + @@ROWCOUNT;


	    MERGE INTO stg.CustomerStage AS tgt
    USING fin.Budget AS src ON src.[ID] = tgt.[ID]
    WHEN MATCHED THEN

        UPDATE SET tgt.[Name] = src.[Name], tgt.[UpdatedDate] = GETUTCDATE()
    WHEN NOT MATCHED BY TARGET THEN
        INSERT ([ID], [Name], [CreatedDate]) VALUES (src.[ID], src.[Name], GETUTCDATE())
    WHEN NOT MATCHED BY SOURCE THEN
	        UPDATE SET tgt.[IsDeleted] = 1;

	    EXEC dbo.usp_UpdateCustomer @ProcessDate = GETDATE(), @BatchID = @BatchID;

	    EXEC [dbo].[usp_ProcessOrder] @ProcessDate = GETDATE(), @BatchID = @BatchID;
	
    EXEC [etl].[usp_LoadProducts] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC fin.usp_PostJournal @ProcessDate = GETDATE(), @BatchID = @BatchID;


    EXEC [etl].[usp_ValidateStage] @ProcessDate = GETDATE(), @BatchID = @BatchID;
	
    -- Reference read: dbo.Employee
    SELECT @RowCount = COUNT(*) FROM dbo.Employee WHERE [IsDeleted] = 0;


    -- Reference read: dbo.SalesTarget
	    SELECT @RowCount = COUNT(*) FROM [dbo].[SalesTarget] WHERE [IsDeleted] = 0;

	    -- Reference read: [audit].[AccessLog]
    SELECT @RowCount = COUNT(*) FROM [audit].[AccessLog] WHERE [IsDeleted] = 0;

    -- Reference read: [rpt].[CustomerChurn]

    SELECT @RowCount = COUNT(*) FROM rpt.CustomerChurn WHERE [IsDeleted] = 0;

	    -- Reference read: [fin].[Budget]
    SELECT @RowCount = COUNT(*) FROM fin.Budget WHERE [IsDeleted] = 0;

    SELECT	@RowCount   =  @RowCount + 0;  -- padding stmt


    RETURN @RowCount;
	END
GO