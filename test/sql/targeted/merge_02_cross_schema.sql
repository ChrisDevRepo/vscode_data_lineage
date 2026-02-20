-- MERGE Pattern 02: Cross-schema MERGE with output logging
-- EXPECT  sources:[staging].[OrderLines]  targets:[sales].[OrderLine],[audit].[MergeLog]

DECLARE @MergeResults TABLE (
    [Action]      NVARCHAR(10),
    [OrderLineID] BIGINT,
    [OrderID]     BIGINT,
    [ProductID]   INT
);

MERGE INTO [sales].[OrderLine] AS tgt
USING (
    SELECT
        ol.[OrderLineID],
        ol.[OrderID],
        ol.[ProductID],
        ol.[Quantity],
        ol.[UnitPrice],
        ol.[DiscountPercent],
        ol.[LineTotal],
        ol.[ShipDate],
        ol.[Status]
    FROM   [staging].[OrderLines] AS ol
    WHERE  ol.[BatchDate] = CAST(GETUTCDATE() AS DATE)
) AS src ON tgt.[OrderLineID] = src.[OrderLineID]
WHEN MATCHED THEN
    UPDATE SET
        tgt.[Quantity]        = src.[Quantity],
        tgt.[UnitPrice]       = src.[UnitPrice],
        tgt.[DiscountPercent] = src.[DiscountPercent],
        tgt.[LineTotal]       = src.[LineTotal],
        tgt.[ShipDate]        = src.[ShipDate],
        tgt.[Status]          = src.[Status],
        tgt.[LastUpdated]     = GETUTCDATE()
WHEN NOT MATCHED BY TARGET THEN
    INSERT ([OrderLineID],[OrderID],[ProductID],[Quantity],[UnitPrice],
            [DiscountPercent],[LineTotal],[ShipDate],[Status],[LastUpdated])
    VALUES (src.[OrderLineID],src.[OrderID],src.[ProductID],src.[Quantity],src.[UnitPrice],
            src.[DiscountPercent],src.[LineTotal],src.[ShipDate],src.[Status],GETUTCDATE())
OUTPUT
    $action,
    INSERTED.[OrderLineID],
    INSERTED.[OrderID],
    INSERTED.[ProductID]
INTO @MergeResults ([Action],[OrderLineID],[OrderID],[ProductID]);

-- Log to audit table (real catalog table, not @var)
INSERT INTO [audit].[MergeLog] ([RunDate],[TableName],[Inserted],[Updated],[Deleted])
SELECT
    GETUTCDATE(),
    N'sales.OrderLine',
    SUM(CASE WHEN [Action] = 'INSERT' THEN 1 ELSE 0 END),
    SUM(CASE WHEN [Action] = 'UPDATE' THEN 1 ELSE 0 END),
    0
FROM @MergeResults;
