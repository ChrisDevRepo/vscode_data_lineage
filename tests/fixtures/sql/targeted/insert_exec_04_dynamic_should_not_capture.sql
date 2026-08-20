-- INSERT EXEC Pattern 04: Dynamic proc name via variable — should NOT extract proc as execCall
-- EXPECT  sources:[dbo].[BatchConfig]  targets:  exec:  absent:[dbo].[usp_SomeOtherProc]
-- NOTE: [dbo].[DynamicResult] is inside a string literal (N'INSERT INTO [dbo].[DynamicResult] EXEC ...')
--       Parser strips string content → DynamicResult correctly NOT in targets (by design).
--       This tests: @FullProcRef var not captured, sp_executesql not captured, commented proc not captured.

DECLARE @ProcName    NVARCHAR(256);
DECLARE @SchemaName  NVARCHAR(128);
DECLARE @FullProcRef NVARCHAR(512);
DECLARE @SQL         NVARCHAR(MAX);

SELECT
    @ProcName   = [ProcedureName],
    @SchemaName = [SchemaName]
FROM [dbo].[BatchConfig]
WHERE [ConfigKey] = N'DailyLoadProc'
  AND [IsActive]  = 1;

SET @FullProcRef = QUOTENAME(@SchemaName) + N'.' + QUOTENAME(@ProcName);
SET @SQL = N'INSERT INTO [dbo].[DynamicResult] EXEC ' + @FullProcRef;

-- This is dynamic SQL — parser cannot resolve @FullProcRef to a catalog object
EXEC sp_executesql @SQL;

-- This is a string reference — must NOT be captured
-- Old code: EXEC [dbo].[usp_SomeOtherProc] @Param = 1
