-- GENERATED SP 11: tier=tiny flags=[excessiveDeclare]
-- EXPECT  sources:[dbo].[Address]  targets:[dbo].[Shipper]  exec:[dbo].[usp_ArchiveOrders]

CREATE PROCEDURE [dbo].[usp_GenTiny_011]
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

    INSERT INTO dbo.Shipper ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   dbo.Address AS s
    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    EXEC [dbo].[usp_ArchiveOrders] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: dbo.Address
    SELECT @RowCount = COUNT(*) FROM dbo.Address WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO