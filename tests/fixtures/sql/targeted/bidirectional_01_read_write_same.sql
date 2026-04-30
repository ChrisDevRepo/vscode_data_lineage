-- BIDIRECTIONAL Pattern 01: SP reads AND writes same table — both edges expected
-- EXPECT  sources:[dbo].[Account],[dbo].[Transaction]  targets:[dbo].[Account],[dbo].[AuditLog]  exec:
-- Account appears in BOTH sources and targets — bidirectional ⇄ edge in lineage graph

-- Read current balance from Account, then update it after recording the transaction
DECLARE @AccountID  INT = 42;
DECLARE @Amount     DECIMAL(18,2) = 500.00;
DECLARE @Balance    DECIMAL(18,2);
DECLARE @NewBalance DECIMAL(18,2);

-- READ: check current balance
SELECT @Balance = [Balance]
FROM   [dbo].[Account]
WHERE  [AccountID] = @AccountID;

-- READ: get pending transactions to apply
INSERT INTO [dbo].[AuditLog] ([AccountID],[ActionType],[OldBalance],[ActionDate])
SELECT @AccountID, N'PRE_APPLY', @Balance, GETUTCDATE()
WHERE  EXISTS (
    SELECT 1 FROM [dbo].[Transaction]
    WHERE  [AccountID] = @AccountID AND [Status] = N'PENDING'
);

-- WRITE: apply transactions to Account
UPDATE [dbo].[Account]
SET
    [Balance]      = [Balance] + t.[NetAmount],
    [LastActivity] = GETUTCDATE()
FROM [dbo].[Account] AS a
JOIN (
    SELECT [AccountID], SUM([Amount]) AS NetAmount
    FROM   [dbo].[Transaction]
    WHERE  [AccountID] = @AccountID AND [Status] = N'PENDING'
    GROUP  BY [AccountID]
) AS t ON t.[AccountID] = a.[AccountID];
