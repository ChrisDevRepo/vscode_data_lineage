-- MULTI-DML Pattern 01: ETL pipeline — stage → transform → load with 5 INSERT + 3 UPDATE
-- EXPECT  sources:[raw].[InboundOrder],[ops].[ExchangeRate],[stg].[Order],[stg].[OrderLine],[dbo].[DimCustomer]  targets:[stg].[Order],[stg].[OrderLine],[dbo].[OrderFact],[dbo].[OrderLineFact],[dbo].[DimCustomer],[ops].[ETLRun]  exec:[dbo].[usp_ValidateOrder]

DECLARE @RunID    INT;
DECLARE @RunStart DATETIME2 = SYSUTCDATETIME();
DECLARE @Errors   INT = 0;

-- Step 1: Log ETL start
INSERT INTO [ops].[ETLRun] ([RunStart],[ProcName],[Status])
VALUES (@RunStart, N'usp_LoadOrderFact', N'RUNNING');
SET @RunID = SCOPE_IDENTITY();

-- Step 2: Stage raw orders
INSERT INTO [stg].[Order] ([OrderID],[CustomerID],[OrderDate],[CurrencyCode],[TotalAmount],[RawAmount],[Status],[StageDate])
SELECT
    r.[OrderID],
    r.[CustomerID],
    r.[OrderDate],
    r.[CurrencyCode],
    r.[Amount] * ISNULL(er.[Rate],1.0),
    r.[Amount],
    r.[Status],
    GETUTCDATE()
FROM [raw].[InboundOrder]  AS r
LEFT JOIN [ops].[ExchangeRate] AS er ON er.[FromCurrency] = r.[CurrencyCode]
                                     AND er.[ToCurrency]  = N'USD'
                                     AND er.[RateDate]    = CAST(r.[OrderDate] AS DATE)
WHERE r.[LoadedDate] = CAST(@RunStart AS DATE);

-- Step 3: Stage order lines
INSERT INTO [stg].[OrderLine] ([OrderID],[LineID],[ProductID],[Qty],[UnitPrice],[LineTotal],[StageDate])
SELECT
    r.[OrderID],
    r.[LineNumber],
    r.[ProductID],
    r.[Quantity],
    r.[UnitPrice],
    r.[Quantity] * r.[UnitPrice],
    GETUTCDATE()
FROM [raw].[InboundOrder] AS r
WHERE r.[RecordType] = N'LINE'
  AND r.[LoadedDate]  = CAST(@RunStart AS DATE);

-- Step 4: Validate staged data
EXEC [dbo].[usp_ValidateOrder] @RunID = @RunID;

-- Step 5: Load order fact
INSERT INTO [dbo].[OrderFact] ([RunID],[OrderID],[CustomerID],[OrderDate],[TotalAmount],[CurrencyCode],[DimCustomerKey])
SELECT
    @RunID,
    s.[OrderID],
    s.[CustomerID],
    s.[OrderDate],
    s.[TotalAmount],
    s.[CurrencyCode],
    dc.[DimCustomerKey]
FROM [stg].[Order] AS s
JOIN [dbo].[DimCustomer] AS dc ON dc.[CustomerID] = s.[CustomerID]
WHERE s.[Status] = N'VALID';

-- Step 6: Load order line fact
INSERT INTO [dbo].[OrderLineFact] ([RunID],[OrderID],[LineID],[ProductID],[Qty],[UnitPrice],[LineTotal])
SELECT @RunID, sl.[OrderID], sl.[LineID], sl.[ProductID], sl.[Qty], sl.[UnitPrice], sl.[LineTotal]
FROM [stg].[OrderLine] AS sl
JOIN [stg].[Order]     AS so ON so.[OrderID] = sl.[OrderID] AND so.[Status] = N'VALID';

-- Step 7: Update customer dimension with latest order info
UPDATE dc
SET
    dc.[LastOrderDate]  = agg.[MaxDate],
    dc.[TotalOrders]    = dc.[TotalOrders] + agg.[NewOrders],
    dc.[LifetimeValue]  = dc.[LifetimeValue] + agg.[NewAmount],
    dc.[ModifiedDate]   = GETUTCDATE()
FROM [dbo].[DimCustomer] AS dc
JOIN (
    SELECT [CustomerID], MAX([OrderDate]) AS MaxDate, COUNT(1) AS NewOrders, SUM([TotalAmount]) AS NewAmount
    FROM   [stg].[Order]
    WHERE  [Status] = N'VALID'
    GROUP BY [CustomerID]
) AS agg ON agg.[CustomerID] = dc.[CustomerID];

-- Step 8: Update ETL run status
UPDATE [ops].[ETLRun]
SET    [Status] = N'COMPLETE', [RunEnd] = SYSUTCDATETIME(), [RowsProcessed] = @@ROWCOUNT
WHERE  [RunID] = @RunID;
