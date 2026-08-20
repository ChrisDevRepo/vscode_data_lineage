-- DECLARE HEAVY Pattern 01: Massive DECLARE block before any logic — all table refs still captured
-- EXPECT  sources:[dbo].[Config],[dbo].[Customer],[dbo].[Order],[dbo].[Product],[ref].[Region]  targets:[dbo].[DailyReport],[ops].[RunLog]  exec:[dbo].[usp_SendAlert]

-- 40+ DECLARE statements — common in legacy ETL SPs
DECLARE @RunID              BIGINT;
DECLARE @RunStart           DATETIME2;
DECLARE @RunEnd             DATETIME2;
DECLARE @RowsRead           INT = 0;
DECLARE @RowsWritten        INT = 0;
DECLARE @RowsSkipped        INT = 0;
DECLARE @RowsError          INT = 0;
DECLARE @StartDate          DATE;
DECLARE @EndDate            DATE;
DECLARE @ReportPeriod       NVARCHAR(20);
DECLARE @ReportTitle        NVARCHAR(500);
DECLARE @ReportSubTitle     NVARCHAR(500);
DECLARE @MaxRows            INT;
DECLARE @MinAmount          DECIMAL(18,2);
DECLARE @MaxAmount          DECIMAL(18,2);
DECLARE @FilterRegion       NVARCHAR(100);
DECLARE @FilterStatus       NVARCHAR(50);
DECLARE @FilterProduct      NVARCHAR(200);
DECLARE @IsFullRefresh      BIT = 0;
DECLARE @IsDebugMode        BIT = 0;
DECLARE @IsSendAlert        BIT = 1;
DECLARE @AlertThreshold     INT;
DECLARE @ErrorCode          INT = 0;
DECLARE @ErrorMessage       NVARCHAR(MAX);
DECLARE @ErrorSeverity      INT;
DECLARE @ErrorState         INT;
DECLARE @RetryCount         INT = 0;
DECLARE @MaxRetries         INT = 3;
DECLARE @PageSize           INT = 10000;
DECLARE @PageNumber         INT = 1;
DECLARE @TotalPages         INT;
DECLARE @SQL                NVARCHAR(MAX);
DECLARE @ParamStr           NVARCHAR(2000);
DECLARE @ConfigKey          NVARCHAR(100);
DECLARE @ConfigValue        NVARCHAR(500);
DECLARE @SchemaName         NVARCHAR(128);
DECLARE @TableName          NVARCHAR(256);
DECLARE @ColumnList         NVARCHAR(2000);
DECLARE @WhereClause        NVARCHAR(2000);
DECLARE @OrderByClause      NVARCHAR(500);
DECLARE @TempPath           NVARCHAR(500);
DECLARE @OutputFormat       NVARCHAR(20);
DECLARE @Delimiter          NCHAR(1);

SET @RunStart     = SYSUTCDATETIME();

-- Read config
SELECT
    @StartDate       = CAST([Value] AS DATE),
    @MaxRows         = CAST([Value2] AS INT),
    @FilterRegion    = [Value3],
    @AlertThreshold  = CAST([Value4] AS INT)
FROM [dbo].[Config]
WHERE [ConfigName] = N'DailyReportSettings';

-- Main data load
INSERT INTO [dbo].[DailyReport] (
    [RunID],[ReportDate],[CustomerID],[CustomerName],[Region],
    [OrderCount],[TotalAmount],[ProductCount],[ReportedAt]
)
SELECT
    @RunID,
    CAST(GETDATE() AS DATE),
    c.[CustomerID],
    c.[FullName],
    r.[RegionName],
    COUNT(o.[OrderID]),
    SUM(o.[TotalAmount]),
    COUNT(DISTINCT p.[ProductID]),
    GETUTCDATE()
FROM      [dbo].[Customer] AS c
JOIN      [ref].[Region]   AS r ON r.[RegionCode] = c.[RegionCode]
LEFT JOIN [dbo].[Order]    AS o ON o.[CustomerID] = c.[CustomerID]
                                AND o.[OrderDate] >= @StartDate
LEFT JOIN [dbo].[Product]  AS p ON p.[ProductID]  = o.[ProductID]
WHERE r.[RegionName] LIKE @FilterRegion + N'%'
  AND c.[IsActive] = 1
GROUP BY c.[CustomerID], c.[FullName], r.[RegionName];

SET @RowsWritten = @@ROWCOUNT;
SET @RunEnd = SYSUTCDATETIME();

INSERT INTO [ops].[RunLog] ([RunStart],[RunEnd],[RowsWritten],[ProcName])
VALUES (@RunStart, @RunEnd, @RowsWritten, N'usp_GenerateDailyReport');

IF @IsSendAlert = 1 AND @RowsWritten < @AlertThreshold
    EXEC [dbo].[usp_SendAlert] @Message = N'Low row count in DailyReport', @Rows = @RowsWritten;
