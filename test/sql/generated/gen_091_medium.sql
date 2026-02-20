-- GENERATED SP 91: tier=medium flags=[nestedSubqueries,excessiveDeclare]
-- EXPECT  sources:[ops].[PickList],[hr].[Position],[etl].[BatchControl]  targets:[dbo].[Product]  exec:[etl].[usp_LoadOrders]

CREATE PROCEDURE [fin].[usp_GenMedium_091]
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

    INSERT INTO [dbo].[Product] ([ID], [Name])
    SELECT x.[ID], x.[Name]
    FROM (
        SELECT i.[ID], i.[Name], ROW_NUMBER() OVER (ORDER BY i.[UpdatedDate] DESC) AS rn
        FROM (
            SELECT [ID], [Name], [UpdatedDate]
            FROM   ops.PickList
            WHERE  [IsDeleted] = 0
        ) AS i
    ) AS x
    WHERE x.rn = 1;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   dbo.Product AS t
    JOIN   hr.Position AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC etl.usp_LoadOrders @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: ops.PickList
    SELECT @RowCount = COUNT(*) FROM [ops].[PickList] WHERE [IsDeleted] = 0;

    -- Reference read: hr.Position
    SELECT @RowCount = COUNT(*) FROM [hr].[Position] WHERE [IsDeleted] = 0;

    -- Reference read: [etl].[BatchControl]
    SELECT @RowCount = COUNT(*) FROM [etl].[BatchControl] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO