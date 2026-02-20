-- STRINGS Pattern 03: Dynamic SQL via sp_executesql — static refs in config table captured, dynamic content not
-- EXPECT  sources:[dbo].[ETLConfig]  absent:[dbo].[DynamicTarget],[stg].[DynamicSource]

DECLARE @SQL       NVARCHAR(MAX);
DECLARE @TableName NVARCHAR(256);
DECLARE @SchemaName NVARCHAR(128);
DECLARE @FullName  NVARCHAR(512);
DECLARE @RowCount  INT;

-- Read configuration from real table
SELECT
    @TableName  = [TargetTable],
    @SchemaName = [TargetSchema],
    @SQL        = [SqlTemplate]
FROM [dbo].[ETLConfig]
WHERE [ConfigName] = N'DailyLoad'
  AND [IsEnabled]  = 1;

-- @SQL might now contain: 'INSERT INTO [dbo].[DynamicTarget] SELECT * FROM [stg].[DynamicSource]'
-- but this is a runtime string — we cannot statically resolve it
SET @FullName = QUOTENAME(@SchemaName) + N'.' + QUOTENAME(@TableName);

-- Replace placeholder in template
SET @SQL = REPLACE(@SQL, N'{{TARGET}}', @FullName);

-- Execute dynamic SQL — parser cannot see inside @SQL string
EXEC sp_executesql
    @SQL,
    N'@RowCount INT OUTPUT',
    @RowCount = @RowCount OUTPUT;
