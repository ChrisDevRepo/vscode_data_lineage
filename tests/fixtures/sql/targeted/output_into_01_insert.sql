-- OUTPUT INTO Pattern 01: INSERT with OUTPUT INTO catalog table (archive pattern)
-- EXPECT  sources:[dbo].[InboundMessage]  targets:[dbo].[ProcessedMessage],[dbo].[MessageArchive]

INSERT INTO [dbo].[ProcessedMessage] (
    [MessageID],
    [Source],
    [Payload],
    [ReceivedAt],
    [ProcessedAt],
    [Status]
)
OUTPUT
    INSERTED.[MessageID],
    INSERTED.[Source],
    INSERTED.[Payload],
    INSERTED.[ReceivedAt],
    INSERTED.[ProcessedAt],
    INSERTED.[Status],
    GETUTCDATE()  AS [ArchivedAt]
INTO [dbo].[MessageArchive] (
    [MessageID],
    [Source],
    [Payload],
    [ReceivedAt],
    [ProcessedAt],
    [Status],
    [ArchivedAt]
)
SELECT
    m.[MessageID],
    m.[Source],
    m.[Payload],
    m.[ReceivedAt],
    GETUTCDATE(),
    N'PROCESSED'
FROM [dbo].[InboundMessage] AS m
WHERE m.[Status] = N'PENDING'
  AND m.[ReceivedAt] < DATEADD(MINUTE, -5, GETUTCDATE());
