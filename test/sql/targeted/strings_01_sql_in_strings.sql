-- STRINGS Pattern 01: String literals containing SQL keywords — must NOT be captured from strings
-- EXPECT  sources:[dbo].[AuditEvent]  targets:[dbo].[NotificationQueue]  exec:[dbo].[usp_SendEmail]  absent:[dbo].[FakeSrcTable],[dbo].[StringTarget]

DECLARE @Subject  NVARCHAR(500);
DECLARE @Body     NVARCHAR(MAX);
DECLARE @ErrorMsg NVARCHAR(MAX);

-- These strings contain SQL-like text — must NOT trigger rule extraction
SET @Subject = N'Daily ETL Alert: INSERT INTO [dbo].[FakeSrcTable] FROM [staging].[Source] completed';
SET @Body    = N'Query executed: SELECT * FROM [dbo].[StringTarget] WHERE Active = 1 '
             + N'and also UPDATE [dbo].[FakeSrcTable] SET Status = ''Done'' was run. '
             + N'EXEC [dbo].[FakeProc] @Param = 1 also executed at ' + CONVERT(NVARCHAR,GETUTCDATE(),120);

SET @ErrorMsg = N'Error in: INSERT INTO [dbo].[FakeSrcTable] SELECT * FROM [dbo].[StringTarget] -- failed';

-- Read from real table
INSERT INTO [dbo].[NotificationQueue] (
    [Subject],
    [Body],
    [Recipient],
    [CreatedAt],
    [Status]
)
SELECT
    @Subject,
    @Body,
    ae.[Email],
    GETUTCDATE(),
    N'PENDING'
FROM [dbo].[AuditEvent] AS ae
WHERE ae.[EventType] = N'ETL_COMPLETE'
  AND ae.[CreatedAt] >= DATEADD(HOUR,-1,GETUTCDATE());

EXEC [dbo].[usp_SendEmail]
    @QueueID  = NULL,
    @Priority = N'HIGH';
