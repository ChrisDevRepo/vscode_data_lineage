-- GENERATED SP 200: tier=large flags=[weirdWhitespace,commentedOutSQL,excessiveDeclare]
-- EXPECT  sources:[dbo].[Account],[fin].[JournalEntry],[hr].[Employee],[fin].[Transaction]  targets:[dbo].[Payment],[stg].[ProductStage],[stg].[EmployeeStage]  exec:[dbo].[usp_ProcessOrder],[dbo].[usp_UpdateCustomer],[audit].[usp_LogAccess],[dbo].[usp_ApplyDiscount]
	
CREATE PROCEDURE [dbo].[usp_GenLarge_200]
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

    INSERT INTO dbo.Payment ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   dbo.Account AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

	    INSERT INTO stg.ProductStage ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
	        a.[ID]          AS SourceID,
	        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
	        GETUTCDATE()    AS LoadedAt
	    FROM   [dbo].[Account] AS a
    JOIN   fin.JournalEntry AS c ON c.[ID] = a.[ID]
    JOIN   [hr].[Employee] AS d ON d.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    INSERT INTO [stg].[EmployeeStage] ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT

        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
	    FROM   dbo.Account AS a
    JOIN   [fin].[JournalEntry] AS c ON c.[ID] = a.[ID]

    JOIN   [hr].[Employee] AS d ON d.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

	    UPDATE t
	    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   [dbo].[Payment] AS t
    JOIN   fin.JournalEntry AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';

    SET @RowCount = @RowCount + @@ROWCOUNT;

	    MERGE INTO stg.EmployeeStage AS tgt

    USING fin.Transaction AS src ON src.[ID] = tgt.[ID]
	    WHEN MATCHED THEN
	        UPDATE SET tgt.[Name] = src.[Name], tgt.[UpdatedDate] = GETUTCDATE()

    WHEN NOT MATCHED BY TARGET THEN
        INSERT ([ID], [Name], [CreatedDate]) VALUES (src.[ID], src.[Name], GETUTCDATE())
	    WHEN NOT MATCHED BY SOURCE THEN
        UPDATE SET tgt.[IsDeleted] = 1;

    EXEC dbo.usp_ProcessOrder @ProcessDate = GETDATE(), @BatchID = @BatchID;
	
    EXEC [dbo].[usp_UpdateCustomer] @ProcessDate = GETDATE(), @BatchID = @BatchID;


    EXEC [audit].[usp_LogAccess] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC dbo.usp_ApplyDiscount @ProcessDate = GETDATE(), @BatchID = @BatchID;

	    -- Reference read: dbo.Account
    SELECT @RowCount = COUNT(*) FROM [dbo].[Account] WHERE [IsDeleted] = 0;

	    -- Reference read: fin.JournalEntry
    SELECT @RowCount = COUNT(*) FROM fin.JournalEntry WHERE [IsDeleted] = 0;

    -- Reference read: hr.Employee
	    SELECT @RowCount = COUNT(*) FROM [hr].[Employee] WHERE [IsDeleted] = 0;
	
    -- Reference read: [fin].[Transaction]
    SELECT @RowCount = COUNT(*) FROM [fin].[Transaction] WHERE [IsDeleted] = 0;
	

    SELECT	@RowCount   =  @RowCount + 0;  -- padding stmt
	
    RETURN @RowCount;
END

GO