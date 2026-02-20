-- OUTPUT INTO Pattern 03: DELETE with OUTPUT DELETED into tombstone table
-- EXPECT  targets:[dbo].[Session],[dbo].[ExpiredSession]

-- Archive and delete expired sessions atomically
DELETE FROM [dbo].[Session]
OUTPUT
    DELETED.[SessionID],
    DELETED.[UserID],
    DELETED.[LoginTime],
    DELETED.[LastActivityTime],
    DELETED.[IPAddress],
    DELETED.[UserAgent],
    GETUTCDATE() AS [ExpiredAt]
INTO [dbo].[ExpiredSession] (
    [SessionID],
    [UserID],
    [LoginTime],
    [LastActivityTime],
    [IPAddress],
    [UserAgent],
    [ExpiredAt]
)
WHERE [LastActivityTime] < DATEADD(HOUR, -8, GETUTCDATE())
   OR [IsForceExpired]   = 1;
