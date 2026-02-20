-- OUTPUT INTO Pattern 02: UPDATE with OUTPUT DELETED/INSERTED into audit table
-- EXPECT  targets:[dbo].[Account],[audit].[AccountChangeLog]

DECLARE @EffectiveDate DATE = CAST(GETUTCDATE() AS DATE);

UPDATE [dbo].[Account]
SET
    [StatusCode]    = N'SUSPENDED',
    [SuspendedDate] = @EffectiveDate,
    [ModifiedDate]  = GETUTCDATE()
OUTPUT
    DELETED.[AccountID],
    DELETED.[StatusCode]    AS [OldStatus],
    INSERTED.[StatusCode]   AS [NewStatus],
    DELETED.[CreditLimit]   AS [OldCreditLimit],
    INSERTED.[CreditLimit]  AS [NewCreditLimit],
    SUSER_SNAME()           AS [ChangedBy],
    GETUTCDATE()            AS [ChangeDate],
    N'SUSPEND_OVERDUE'      AS [ChangeReason]
INTO [audit].[AccountChangeLog] (
    [AccountID],
    [OldStatus],
    [NewStatus],
    [OldCreditLimit],
    [NewCreditLimit],
    [ChangedBy],
    [ChangeDate],
    [ChangeReason]
)
WHERE [StatusCode] = N'ACTIVE'
  AND [DueDate]    < DATEADD(DAY, -90, @EffectiveDate)
  AND [BalanceDue]  > 0;
