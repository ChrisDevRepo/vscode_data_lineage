-- OUTPUT INTO Pattern 05: OUTPUT INTO @tablevar ONLY — must NOT extract any target from OUTPUT
-- EXPECT  sources:  targets:[dbo].[Order],[dbo].[ProcessedOrder]  exec:
-- NOTE: [dbo].[Order] is a UPDATE target (no FROM clause here → not a source).
--       [dbo].[ProcessedOrder] is an INSERT target.
--       @updatedIDs is a @table variable → correctly rejected by normalizeCaptured.

DECLARE @updatedIDs TABLE ([OrderID] INT, [OldStatus] NVARCHAR(20), [NewStatus] NVARCHAR(20));

UPDATE [dbo].[Order]
SET
    [StatusCode]   = N'PROCESSING',
    [ModifiedDate] = GETUTCDATE()
OUTPUT
    DELETED.[OrderID],
    DELETED.[StatusCode],
    INSERTED.[StatusCode]
INTO @updatedIDs ([OrderID],[OldStatus],[NewStatus])
WHERE [StatusCode] = N'SUBMITTED'
  AND [SubmittedDate] < DATEADD(HOUR,-1,GETUTCDATE());

-- Now use the IDs to insert a summary record — THIS is the real catalog target
INSERT INTO [dbo].[ProcessedOrder] ([OrderID],[ProcessedAt],[PreviousStatus])
SELECT [OrderID], GETUTCDATE(), [OldStatus]
FROM   @updatedIDs;
