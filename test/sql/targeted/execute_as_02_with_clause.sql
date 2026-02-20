-- EXECUTE AS Pattern 02: WITH EXECUTE AS OWNER in CREATE PROC header (DMV-style full body)
-- EXPECT  sources:[security].[PermissionMatrix],[dbo].[User]  targets:[security].[UserPermission]  absent:[OWNER]

-- This is a DMV-style body (sys.sql_modules returns full CREATE OR ALTER text)
CREATE OR ALTER PROCEDURE [security].[usp_RefreshUserPermissions]
    @UserID      INT = NULL,
    @ForceRefresh BIT = 0
WITH EXECUTE AS OWNER   -- OWNER is not a table/proc — must not be captured
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @Now DATETIME2 = SYSUTCDATETIME();

    -- Clear existing permissions for user (or all if @UserID IS NULL)
    DELETE FROM [security].[UserPermission]
    WHERE (@UserID IS NULL OR [UserID] = @UserID)
      AND (@ForceRefresh = 1 OR [ExpiresAt] < @Now);

    -- Rebuild permissions from matrix
    INSERT INTO [security].[UserPermission] (
        [UserID],
        [PermissionCode],
        [ResourceType],
        [ResourceID],
        [GrantedAt],
        [ExpiresAt],
        [GrantedBy]
    )
    SELECT DISTINCT
        u.[UserID],
        pm.[PermissionCode],
        pm.[ResourceType],
        pm.[ResourceID],
        @Now,
        DATEADD(DAY, pm.[DurationDays], @Now),
        SUSER_SNAME()
    FROM      [dbo].[User]                AS u
    JOIN      [security].[PermissionMatrix] AS pm ON pm.[RoleCode] = u.[RoleCode]
    WHERE (u.[UserID] = @UserID OR @UserID IS NULL)
      AND u.[IsActive] = 1
      AND pm.[IsActive] = 1;

END;
