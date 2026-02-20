-- TRY/CATCH Pattern 02: Transaction with retry logic and XACT_ABORT
-- EXPECT  sources:[dbo].[TransferRequest],[dbo].[Account]  targets:[dbo].[AccountTransaction],[dbo].[TransferRequest],[dbo].[TransferLog]  exec:[dbo].[usp_UpdateBalance]

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @MaxRetries  INT         = 3;
DECLARE @RetryCount  INT         = 0;
DECLARE @RetryDelay  VARCHAR(8)  = N'00:00:02';
DECLARE @TransferID  BIGINT;
DECLARE @FromAccount INT;
DECLARE @ToAccount   INT;
DECLARE @Amount      DECIMAL(18,4);

SELECT TOP 1
    @TransferID  = [TransferID],
    @FromAccount = [FromAccountID],
    @ToAccount   = [ToAccountID],
    @Amount      = [Amount]
FROM [dbo].[TransferRequest]
WHERE [Status] = N'QUEUED'
ORDER BY [Priority] DESC, [RequestedAt] ASC;

WHILE @RetryCount <= @MaxRetries
BEGIN
    BEGIN TRY
        BEGIN TRANSACTION;

        -- Validate both accounts exist and are active
        IF NOT EXISTS (SELECT 1 FROM [dbo].[Account] WHERE [AccountID] = @FromAccount AND [IsActive] = 1)
            THROW 50010, 'Source account not active', 1;
        IF NOT EXISTS (SELECT 1 FROM [dbo].[Account] WHERE [AccountID] = @ToAccount   AND [IsActive] = 1)
            THROW 50011, 'Target account not active', 1;

        -- Debit source
        EXEC [dbo].[usp_UpdateBalance]
            @AccountID = @FromAccount,
            @Delta     = @Amount * -1,
            @Reason    = N'TRANSFER_OUT';

        -- Credit target
        EXEC [dbo].[usp_UpdateBalance]
            @AccountID = @ToAccount,
            @Delta     = @Amount,
            @Reason    = N'TRANSFER_IN';

        -- Record transaction
        INSERT INTO [dbo].[AccountTransaction] ([TransferID],[AccountID],[Direction],[Amount],[PostedAt])
        VALUES (@TransferID, @FromAccount, N'DR', @Amount, SYSUTCDATETIME()),
               (@TransferID, @ToAccount,   N'CR', @Amount, SYSUTCDATETIME());

        UPDATE [dbo].[TransferRequest]
        SET    [Status] = N'COMPLETE', [CompletedAt] = SYSUTCDATETIME()
        WHERE  [TransferID] = @TransferID;

        INSERT INTO [dbo].[TransferLog] ([TransferID],[Attempt],[Result],[LoggedAt])
        VALUES (@TransferID, @RetryCount + 1, N'SUCCESS', SYSUTCDATETIME());

        COMMIT TRANSACTION;
        BREAK;  -- success — exit retry loop

    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        SET @RetryCount += 1;

        INSERT INTO [dbo].[TransferLog] ([TransferID],[Attempt],[Result],[ErrorMsg],[LoggedAt])
        VALUES (@TransferID, @RetryCount, N'RETRY', ERROR_MESSAGE(), SYSUTCDATETIME());

        IF @RetryCount > @MaxRetries
        BEGIN
            UPDATE [dbo].[TransferRequest]
            SET    [Status] = N'FAILED', [FailedAt] = SYSUTCDATETIME(), [LastError] = ERROR_MESSAGE()
            WHERE  [TransferID] = @TransferID;
            THROW;
        END;

        WAITFOR DELAY @RetryDelay;
    END CATCH;
END;
