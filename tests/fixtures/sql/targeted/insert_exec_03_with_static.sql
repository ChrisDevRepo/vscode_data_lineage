-- INSERT EXEC Pattern 03: INSERT EXEC combined with static SELECT/INSERT
-- EXPECT  sources:[dbo].[Product],[dbo].[Category]  targets:[dbo].[AuditBatch],[dbo].[SalesFact],[dbo].[DimProduct]  exec:[etl].[usp_TransformSales]

DECLARE @BatchID  INT;
DECLARE @BatchTS  DATETIME2 = SYSUTCDATETIME();

-- 1. Log the batch start (static INSERT)
INSERT INTO [dbo].[AuditBatch] ([BatchStart],[ProcName],[Status])
VALUES (@BatchTS, N'etl_daily_load', N'RUNNING');

SET @BatchID = SCOPE_IDENTITY();

-- 2. Load sales fact via SP execution
INSERT INTO [dbo].[SalesFact]
    ([BatchID],[OrderDate],[ProductID],[CustomerID],[Qty],[Amount],[CurrencyCode])
EXEC [etl].[usp_TransformSales]
    @BatchID    = @BatchID,
    @StartDate  = CAST(DATEADD(DAY,-1,GETDATE()) AS DATE),
    @EndDate    = CAST(GETDATE() AS DATE);

-- 3. Refresh product dimension (static SELECT)
INSERT INTO [dbo].[DimProduct] ([ProductID],[ProductName],[CategoryName],[ListPrice],[IsActive])
SELECT
    p.[ProductID],
    p.[Name],
    c.[CategoryName],
    p.[ListPrice],
    p.[SellEndDate] IS NULL
FROM [dbo].[Product]  AS p
JOIN [dbo].[Category] AS c ON c.[CategoryID] = p.[ProductCategoryID]
WHERE p.[ModifiedDate] >= DATEADD(DAY,-2,GETDATE());

-- 4. Update batch status
UPDATE [dbo].[AuditBatch]
SET    [Status] = N'COMPLETE', [BatchEnd] = SYSUTCDATETIME()
WHERE  [BatchID] = @BatchID;
