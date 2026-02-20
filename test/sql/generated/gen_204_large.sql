-- GENERATED SP 204: tier=large flags=[weirdWhitespace,variableTableHeavy,commentedOutSQL]
-- EXPECT  sources:[ops].[PickList],[hr].[Department],[audit].[ChangeLog],[dbo].[Transaction]  targets:[dbo].[PriceList],[dbo].[Department],[hr].[Position]  exec:[etl].[usp_LoadCustomers],[dbo].[usp_ArchiveOrders],[etl].[usp_ValidateStage],[fin].[usp_PostJournal]

	CREATE PROCEDURE [rpt].[usp_GenLarge_204]
    @BatchID    INT = 0,
	    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;

    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

	    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

	    DECLARE @TempBuffer TABLE ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2));
    -- @table variable populated from logic above — not a catalog dependency
    DECLARE @StagingRows TABLE ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2));
    -- @table variable populated from logic above — not a catalog dependency
	

    -- OLD CODE (removed 2019-06-15) — kept for reference:
	    -- INSERT INTO dbo.DeprecatedLog (EntityID, Action, LogDate)
    -- SELECT ID, N'PROCESS', GETDATE() FROM dbo.OldLegacyTable WHERE Status = 0
    -- UPDATE dbo.OldFlag SET Active = 0 WHERE ProcessDate < '2019-01-01'
    -- EXEC dbo.usp_OldArchive @cutoff = '2019-01-01'

    INSERT INTO [dbo].[PriceList] ([SourceID], [SourceName], [LoadedAt])
    SELECT s.[ID], s.[Name], GETUTCDATE()
    FROM   [ops].[PickList] AS s
	    WHERE  s.[IsDeleted] = 0;
    SET @RowCount = @RowCount + @@ROWCOUNT;

	    INSERT INTO [dbo].[Department] ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
	        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
	        ISNULL(a.[Amount], 0) AS Amount,
	        GETUTCDATE()    AS LoadedAt
	    FROM   ops.PickList AS a
    JOIN   [hr].[Department] AS c ON c.[ID] = a.[ID]
    JOIN   audit.ChangeLog AS d ON d.[ID] = a.[ID]

    WHERE  a.[Status] = N'PENDING';
	    SET @RowCount = @RowCount + @@ROWCOUNT;
	
    INSERT INTO hr.Position ([SourceID], [RefID], [Amount], [LoadedAt])
	    SELECT
        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
	        ISNULL(a.[Amount], 0) AS Amount,
	        GETUTCDATE()    AS LoadedAt
    FROM   ops.PickList AS a

    JOIN   hr.Department AS c ON c.[ID] = a.[ID]

    JOIN   [audit].[ChangeLog] AS d ON d.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
	    SET @RowCount = @RowCount + @@ROWCOUNT;

	    UPDATE t
	    SET    t.[Status]      = s.[Status],
	           t.[UpdatedDate] = GETUTCDATE()
	    FROM   [dbo].[PriceList] AS t
	    JOIN   [hr].[Department] AS s ON s.[ID] = t.[SourceID]
	    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;
	
    MERGE INTO hr.Position AS tgt
    USING dbo.Transaction AS src ON src.[ID] = tgt.[ID]
    WHEN MATCHED THEN

        UPDATE SET tgt.[Name] = src.[Name], tgt.[UpdatedDate] = GETUTCDATE()
    WHEN NOT MATCHED BY TARGET THEN
	        INSERT ([ID], [Name], [CreatedDate]) VALUES (src.[ID], src.[Name], GETUTCDATE())

    WHEN NOT MATCHED BY SOURCE THEN
        UPDATE SET tgt.[IsDeleted] = 1;
	
    EXEC etl.usp_LoadCustomers @ProcessDate = GETDATE(), @BatchID = @BatchID;
	
    EXEC dbo.usp_ArchiveOrders @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC etl.usp_ValidateStage @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [fin].[usp_PostJournal] @ProcessDate = GETDATE(), @BatchID = @BatchID;
	

    -- Reference read: [ops].[PickList]
	    SELECT @RowCount = COUNT(*) FROM [ops].[PickList] WHERE [IsDeleted] = 0;


    -- Reference read: [hr].[Department]

    SELECT @RowCount = COUNT(*) FROM hr.Department WHERE [IsDeleted] = 0;

	    -- Reference read: audit.ChangeLog
	    SELECT @RowCount = COUNT(*) FROM audit.ChangeLog WHERE [IsDeleted] = 0;

    -- Reference read: dbo.Transaction
	    SELECT @RowCount = COUNT(*) FROM dbo.Transaction WHERE [IsDeleted] = 0;

    SELECT	@RowCount   =  @RowCount + 0;  -- padding stmt
	
    RETURN @RowCount;
END

GO