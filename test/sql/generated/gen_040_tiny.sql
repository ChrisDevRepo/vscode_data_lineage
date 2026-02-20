-- GENERATED SP 40: tier=tiny flags=[excessiveDeclare]
-- EXPECT  sources:[stg].[ProductStage],[stg].[InvoiceStage]  targets:[dbo].[Order]  exec:[etl].[usp_LoadOrders]

CREATE PROCEDURE [hr].[usp_GenTiny_040]
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

    INSERT INTO [dbo].[Order] ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [stg].[ProductStage] AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC etl.usp_LoadOrders @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [stg].[ProductStage]
    SELECT @RowCount = COUNT(*) FROM stg.ProductStage WHERE [IsDeleted] = 0;

    -- Reference read: stg.InvoiceStage
    SELECT @RowCount = COUNT(*) FROM [stg].[InvoiceStage] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO