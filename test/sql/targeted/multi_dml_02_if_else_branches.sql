-- MULTI-DML Pattern 02: IF/ELSE branches with different tables per branch
-- EXPECT  sources:[dbo].[Config],[dbo].[IncrementalData],[dbo].[FullData],[dbo].[Customer]  targets:[dbo].[DataWarehouse],[dbo].[DataWarehouseArchive],[ops].[LoadLog]  exec:
-- All branches are visible to static parser — all tables in all branches must be captured

DECLARE @LoadType   NVARCHAR(20);
DECLARE @LastLoad   DATETIME2;
DECLARE @RowsLoaded INT = 0;

SELECT
    @LoadType = [Value],
    @LastLoad = CAST([Value2] AS DATETIME2)
FROM [dbo].[Config]
WHERE [Key] = N'DW_LOAD_MODE';

IF @LoadType = N'INCREMENTAL'
BEGIN
    -- Branch 1: Incremental load from delta table
    INSERT INTO [dbo].[DataWarehouse] (
        [ID],[CustomerID],[DataDate],[Value],[LoadType],[LoadedAt]
    )
    SELECT
        id.[ID],
        id.[CustomerID],
        id.[DataDate],
        id.[Value],
        N'INCREMENTAL',
        GETUTCDATE()
    FROM [dbo].[IncrementalData] AS id
    JOIN [dbo].[Customer]        AS c  ON c.[CustomerID] = id.[CustomerID]
    WHERE id.[ChangedDate] > @LastLoad
      AND id.[IsDeleted]   = 0;

    SET @RowsLoaded = @@ROWCOUNT;
END
ELSE IF @LoadType = N'FULL'
BEGIN
    -- Branch 2: Full reload — archive old data first
    INSERT INTO [dbo].[DataWarehouseArchive] ([ID],[CustomerID],[DataDate],[Value],[ArchivedAt])
    SELECT [ID],[CustomerID],[DataDate],[Value],GETUTCDATE()
    FROM   [dbo].[DataWarehouse];

    TRUNCATE TABLE [dbo].[DataWarehouse];

    -- Reload from full dataset
    INSERT INTO [dbo].[DataWarehouse] (
        [ID],[CustomerID],[DataDate],[Value],[LoadType],[LoadedAt]
    )
    SELECT
        fd.[ID],
        fd.[CustomerID],
        fd.[DataDate],
        fd.[Value],
        N'FULL',
        GETUTCDATE()
    FROM [dbo].[FullData]  AS fd
    JOIN [dbo].[Customer]  AS c ON c.[CustomerID] = fd.[CustomerID];

    SET @RowsLoaded = @@ROWCOUNT;
END;

-- Log outcome regardless of branch taken
INSERT INTO [ops].[LoadLog] ([LoadType],[RowsLoaded],[LoadedAt])
VALUES (@LoadType, @RowsLoaded, GETUTCDATE());
