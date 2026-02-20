-- GENERATED SP 183: tier=large flags=[allCaps,excessiveDeclare,noBrackets]
-- EXPECT  sources:[dbo].[Region],[dbo].[TRANSACTION],[fin].[Account],[etl].[LoadLog],[hr].[Position],[hr].[Department]  targets:[dbo].[PriceList],[stg].[PaymentStage]  EXEC:[fin].[usp_PostJournal],[dbo].[usp_ApplyDiscount],[etl].[usp_LoadCustomers]

CREATE PROCEDURE [ops].[usp_GenLarge_183]
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

    INSERT INTO dbo.PriceList ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   dbo.Region AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    INSERT INTO stg.PaymentStage ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
    FROM   dbo.Region AS a
    JOIN   dbo.TRANSACTION AS c ON c.[ID] = a.[ID]
    JOIN   fin.Account AS d ON d.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   dbo.PriceList AS t
    JOIN   dbo.TRANSACTION AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    MERGE INTO stg.PaymentStage AS tgt
    USING hr.Department AS src ON src.[ID] = tgt.[ID]
    WHEN MATCHED THEN
        UPDATE SET tgt.[Name] = src.[Name], tgt.[UpdatedDate] = GETUTCDATE()
    WHEN NOT MATCHED BY TARGET THEN
        INSERT ([ID], [Name], [CreatedDate]) VALUES (src.[ID], src.[Name], GETUTCDATE())
    WHEN NOT MATCHED BY SOURCE THEN
        UPDATE SET tgt.[IsDeleted] = 1;

    EXEC fin.usp_PostJournal @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC dbo.usp_ApplyDiscount @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC etl.usp_LoadCustomers @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: dbo.Region
    SELECT @RowCount = COUNT(*) FROM dbo.Region WHERE [IsDeleted] = 0;

    -- Reference read: dbo.TRANSACTION
    SELECT @RowCount = COUNT(*) FROM dbo.TRANSACTION WHERE [IsDeleted] = 0;

    -- Reference read: fin.Account
    SELECT @RowCount = COUNT(*) FROM fin.Account WHERE [IsDeleted] = 0;

    -- Reference read: etl.LoadLog
    SELECT @RowCount = COUNT(*) FROM etl.LoadLog WHERE [IsDeleted] = 0;

    -- Reference read: hr.Position
    SELECT @RowCount = COUNT(*) FROM hr.Position WHERE [IsDeleted] = 0;

    -- Reference read: hr.Department
    SELECT @RowCount = COUNT(*) FROM hr.Department WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO