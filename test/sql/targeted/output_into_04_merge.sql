-- OUTPUT INTO Pattern 04: MERGE with OUTPUT INTO result tracking table
-- EXPECT  sources:[staging].[InventoryFeed]  targets:[wh].[Inventory],[ops].[MergeRunLog]
-- @changes is a @tablevar — must NOT be captured

DECLARE @changes TABLE (
    [Action]    NVARCHAR(10),
    [ProductID] INT,
    [OldQty]    INT,
    [NewQty]    INT
);

MERGE INTO [wh].[Inventory] AS tgt
USING [staging].[InventoryFeed] AS src
    ON tgt.[ProductID]  = src.[ProductID]
    AND tgt.[LocationID] = src.[LocationID]
WHEN MATCHED THEN
    UPDATE SET
        tgt.[QtyOnHand]  = src.[QtyOnHand],
        tgt.[LastCounted] = src.[CountDate]
WHEN NOT MATCHED BY TARGET THEN
    INSERT ([ProductID],[LocationID],[QtyOnHand],[LastCounted])
    VALUES (src.[ProductID],src.[LocationID],src.[QtyOnHand],src.[CountDate])
OUTPUT
    $action,
    COALESCE(INSERTED.[ProductID], DELETED.[ProductID]),
    DELETED.[QtyOnHand],
    INSERTED.[QtyOnHand]
INTO @changes ([Action],[ProductID],[OldQty],[NewQty]);

-- Persist run summary to catalog table (not @var)
INSERT INTO [ops].[MergeRunLog] ([RunDate],[TableName],[Inserted],[Updated],[TotalRows])
SELECT
    GETUTCDATE(),
    N'wh.Inventory',
    SUM(CASE WHEN [Action] = 'INSERT' THEN 1 ELSE 0 END),
    SUM(CASE WHEN [Action] = 'UPDATE' THEN 1 ELSE 0 END),
    COUNT(1)
FROM @changes;
