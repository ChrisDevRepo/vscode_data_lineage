-- GENERATED SP 153: tier=large flags=[nestedSubqueries,printStatements,cursorLoop]
-- EXPECT  sources:[dbo].[Region],[dbo].[Department],[ops].[PickList],[fin].[CostCenter],[stg].[ProductStage],[dbo].[Invoice]  targets:[rpt].[EmployeePerf],[dbo].[Warehouse]  exec:[dbo].[usp_UpdateCustomer],[dbo].[usp_GenerateInvoice],[etl].[usp_LoadCustomers],[dbo].[usp_ArchiveOrders],[dbo].[usp_ProcessOrder],[audit].[usp_LogChange]

CREATE PROCEDURE [rpt].[usp_GenLarge_153]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    DECLARE cur_Process CURSOR LOCAL FAST_FORWARD FOR
        SELECT [ID], [Name] FROM dbo.Region WHERE [Status] = N'PENDING';
    
    DECLARE @CurID INT, @CurName NVARCHAR(200);
    OPEN cur_Process;
    FETCH NEXT FROM cur_Process INTO @CurID, @CurName;
    WHILE @@FETCH_STATUS = 0
    BEGIN
        -- Process each row
        SET @BatchID = @CurID;
        PRINT N'Processing: ' + ISNULL(@CurName, N'NULL');
        FETCH NEXT FROM cur_Process INTO @CurID, @CurName;
    END
    CLOSE cur_Process;
    DEALLOCATE cur_Process;

    INSERT INTO [rpt].[EmployeePerf] ([ID], [Name])
    SELECT x.[ID], x.[Name]
    FROM (
        SELECT i.[ID], i.[Name], ROW_NUMBER() OVER (ORDER BY i.[UpdatedDate] DESC) AS rn
        FROM (
            SELECT [ID], [Name], [UpdatedDate]
            FROM   [dbo].[Region]
            WHERE  [IsDeleted] = 0
        ) AS i
    ) AS x
    WHERE x.rn = 1;
    SET @RowCount = @RowCount + @@ROWCOUNT;

    PRINT N'Step 2: Processing batch @BatchID = ' + CAST(@BatchID AS NVARCHAR) + N', elapsed: ' + CAST(DATEDIFF(ms, @StartTime, GETUTCDATE()) AS NVARCHAR) + N' ms';

    INSERT INTO dbo.Warehouse ([SourceID], [RefID], [Amount], [LoadedAt])
    SELECT
        a.[ID]          AS SourceID,
        b.[ID]          AS RefID,
        ISNULL(a.[Amount], 0) AS Amount,
        GETUTCDATE()    AS LoadedAt
    FROM   dbo.Region AS a
    JOIN   dbo.Department AS c ON c.[ID] = a.[ID]
    JOIN   [ops].[PickList] AS d ON d.[ID] = a.[ID]
    WHERE  a.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    PRINT N'Step 3: Processing batch @BatchID = ' + CAST(@BatchID AS NVARCHAR) + N', elapsed: ' + CAST(DATEDIFF(ms, @StartTime, GETUTCDATE()) AS NVARCHAR) + N' ms';

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   rpt.EmployeePerf AS t
    JOIN   dbo.Department AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    MERGE INTO [dbo].[Warehouse] AS tgt
    USING dbo.Invoice AS src ON src.[ID] = tgt.[ID]
    WHEN MATCHED THEN
        UPDATE SET tgt.[Name] = src.[Name], tgt.[UpdatedDate] = GETUTCDATE()
    WHEN NOT MATCHED BY TARGET THEN
        INSERT ([ID], [Name], [CreatedDate]) VALUES (src.[ID], src.[Name], GETUTCDATE())
    WHEN NOT MATCHED BY SOURCE THEN
        UPDATE SET tgt.[IsDeleted] = 1;

    EXEC [dbo].[usp_UpdateCustomer] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC dbo.usp_GenerateInvoice @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC etl.usp_LoadCustomers @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [dbo].[usp_ArchiveOrders] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [dbo].[usp_ProcessOrder] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC audit.usp_LogChange @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: dbo.Region
    SELECT @RowCount = COUNT(*) FROM [dbo].[Region] WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[Department]
    SELECT @RowCount = COUNT(*) FROM dbo.Department WHERE [IsDeleted] = 0;

    -- Reference read: ops.PickList
    SELECT @RowCount = COUNT(*) FROM [ops].[PickList] WHERE [IsDeleted] = 0;

    -- Reference read: fin.CostCenter
    SELECT @RowCount = COUNT(*) FROM fin.CostCenter WHERE [IsDeleted] = 0;

    -- Reference read: [stg].[ProductStage]
    SELECT @RowCount = COUNT(*) FROM stg.ProductStage WHERE [IsDeleted] = 0;

    -- Reference read: [dbo].[Invoice]
    SELECT @RowCount = COUNT(*) FROM [dbo].[Invoice] WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO