-- GENERATED SP 231: tier=monster flags=[deepTryCatch,nestedSubqueries,cursorLoop,printStatements,variableTableHeavy,noBrackets]
-- EXPECT  sources:[dbo].[Warehouse],[fin].[Budget],[dbo].[Customer],[dbo].[OrderLine],[dbo].[Account],[etl].[BatchControl],[stg].[OrderStage]  targets:[rpt].[CustomerChurn],[hr].[Performance],[dbo].[Transaction]  exec:[hr].[usp_ApproveLeave],[audit].[usp_LogAccess],[dbo].[usp_UpdateCustomer],[dbo].[usp_ProcessOrder],[etl].[usp_LoadProducts],[etl].[usp_ValidateStage],[dbo].[usp_ArchiveOrders]

CREATE PROCEDURE [hr].[usp_GenMonster_231]
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

    DECLARE cur_Process CURSOR LOCAL FAST_FORWARD FOR
        SELECT [ID], [Name] FROM dbo.Warehouse WHERE [Status] = N'PENDING';
    
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

    BEGIN TRY
        BEGIN TRY
            BEGIN TRY
                INSERT INTO rpt.CustomerChurn ([ID], [Name])
                SELECT x.[ID], x.[Name]
                FROM (
                    SELECT i.[ID], i.[Name], ROW_NUMBER() OVER (ORDER BY i.[UpdatedDate] DESC) AS rn
                    FROM (
                        SELECT [ID], [Name], [UpdatedDate]
                        FROM   dbo.Warehouse
                        WHERE  [IsDeleted] = 0
                    ) AS i
                ) AS x
                WHERE x.rn = 1;
            END TRY
            BEGIN CATCH
                SET @ErrorMessage = ERROR_MESSAGE();
                SET @ErrorSeverity = ERROR_SEVERITY();
                SET @ErrorState = ERROR_STATE();
                RAISERROR(@ErrorMessage, @ErrorSeverity, @ErrorState);
            END CATCH
        END TRY
        BEGIN CATCH
            SET @ErrorMessage = ERROR_MESSAGE();
            SET @ErrorSeverity = ERROR_SEVERITY();
            SET @ErrorState = ERROR_STATE();
            RAISERROR(@ErrorMessage, @ErrorSeverity, @ErrorState);
        END CATCH
    END TRY
    BEGIN CATCH
        SET @ErrorMessage = ERROR_MESSAGE();
        SET @ErrorSeverity = ERROR_SEVERITY();
        SET @ErrorState = ERROR_STATE();
        RAISERROR(@ErrorMessage, @ErrorSeverity, @ErrorState);
    END CATCH
    SET @RowCount = @RowCount + @@ROWCOUNT;

    PRINT N'Step 2: Processing batch @BatchID = ' + CAST(@BatchID AS NVARCHAR) + N', elapsed: ' + CAST(DATEDIFF(ms, @StartTime, GETUTCDATE()) AS NVARCHAR) + N' ms';

    BEGIN TRY
        BEGIN TRY
            BEGIN TRY
                INSERT INTO hr.Performance ([SourceID], [RefID], [Amount], [LoadedAt])
                SELECT
                    a.[ID]          AS SourceID,
                    b.[ID]          AS RefID,
                    ISNULL(a.[Amount], 0) AS Amount,
                    GETUTCDATE()    AS LoadedAt
                FROM   dbo.Warehouse AS a
                JOIN   fin.Budget AS c ON c.[ID] = a.[ID]
                JOIN   dbo.Customer AS d ON d.[ID] = a.[ID]
                WHERE  a.[Status] = N'PENDING';
            END TRY
            BEGIN CATCH
                SET @ErrorMessage = ERROR_MESSAGE();
                SET @ErrorSeverity = ERROR_SEVERITY();
                SET @ErrorState = ERROR_STATE();
                RAISERROR(@ErrorMessage, @ErrorSeverity, @ErrorState);
            END CATCH
        END TRY
        BEGIN CATCH
            SET @ErrorMessage = ERROR_MESSAGE();
            SET @ErrorSeverity = ERROR_SEVERITY();
            SET @ErrorState = ERROR_STATE();
            RAISERROR(@ErrorMessage, @ErrorSeverity, @ErrorState);
        END CATCH
    END TRY
    BEGIN CATCH
        SET @ErrorMessage = ERROR_MESSAGE();
        SET @ErrorSeverity = ERROR_SEVERITY();
        SET @ErrorState = ERROR_STATE();
        RAISERROR(@ErrorMessage, @ErrorSeverity, @ErrorState);
    END CATCH
    SET @RowCount = @RowCount + @@ROWCOUNT;

    PRINT N'Step 3: Processing batch @BatchID = ' + CAST(@BatchID AS NVARCHAR) + N', elapsed: ' + CAST(DATEDIFF(ms, @StartTime, GETUTCDATE()) AS NVARCHAR) + N' ms';

    BEGIN TRY
        BEGIN TRY
            BEGIN TRY
                INSERT INTO dbo.Transaction ([SourceID], [RefID], [Amount], [LoadedAt])
                SELECT
                    a.[ID]          AS SourceID,
                    b.[ID]          AS RefID,
                    ISNULL(a.[Amount], 0) AS Amount,
                    GETUTCDATE()    AS LoadedAt
                FROM   dbo.Warehouse AS a
                JOIN   fin.Budget AS c ON c.[ID] = a.[ID]
                JOIN   dbo.Customer AS d ON d.[ID] = a.[ID]
                WHERE  a.[Status] = N'PENDING';
            END TRY
            BEGIN CATCH
                SET @ErrorMessage = ERROR_MESSAGE();
                SET @ErrorSeverity = ERROR_SEVERITY();
                SET @ErrorState = ERROR_STATE();
                RAISERROR(@ErrorMessage, @ErrorSeverity, @ErrorState);
            END CATCH
        END TRY
        BEGIN CATCH
            SET @ErrorMessage = ERROR_MESSAGE();
            SET @ErrorSeverity = ERROR_SEVERITY();
            SET @ErrorState = ERROR_STATE();
            RAISERROR(@ErrorMessage, @ErrorSeverity, @ErrorState);
        END CATCH
    END TRY
    BEGIN CATCH
        SET @ErrorMessage = ERROR_MESSAGE();
        SET @ErrorSeverity = ERROR_SEVERITY();
        SET @ErrorState = ERROR_STATE();
        RAISERROR(@ErrorMessage, @ErrorSeverity, @ErrorState);
    END CATCH
    SET @RowCount = @RowCount + @@ROWCOUNT;

    PRINT N'Step 4: Processing batch @BatchID = ' + CAST(@BatchID AS NVARCHAR) + N', elapsed: ' + CAST(DATEDIFF(ms, @StartTime, GETUTCDATE()) AS NVARCHAR) + N' ms';

    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   rpt.CustomerChurn AS t
    JOIN   fin.Budget AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    MERGE INTO dbo.Transaction AS tgt
    USING stg.OrderStage AS src ON src.[ID] = tgt.[ID]
    WHEN MATCHED THEN
        UPDATE SET tgt.[Name] = src.[Name], tgt.[UpdatedDate] = GETUTCDATE()
    WHEN NOT MATCHED BY TARGET THEN
        INSERT ([ID], [Name], [CreatedDate]) VALUES (src.[ID], src.[Name], GETUTCDATE())
    WHEN NOT MATCHED BY SOURCE THEN
        UPDATE SET tgt.[IsDeleted] = 1;

    EXEC hr.usp_ApproveLeave @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC audit.usp_LogAccess @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC dbo.usp_UpdateCustomer @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC dbo.usp_ProcessOrder @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC etl.usp_LoadProducts @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC etl.usp_ValidateStage @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC dbo.usp_ArchiveOrders @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: dbo.Warehouse
    SELECT @RowCount = COUNT(*) FROM dbo.Warehouse WHERE [IsDeleted] = 0;

    -- Reference read: fin.Budget
    SELECT @RowCount = COUNT(*) FROM fin.Budget WHERE [IsDeleted] = 0;

    -- Reference read: dbo.Customer
    SELECT @RowCount = COUNT(*) FROM dbo.Customer WHERE [IsDeleted] = 0;

    -- Reference read: dbo.OrderLine
    SELECT @RowCount = COUNT(*) FROM dbo.OrderLine WHERE [IsDeleted] = 0;

    -- Reference read: dbo.Account
    SELECT @RowCount = COUNT(*) FROM dbo.Account WHERE [IsDeleted] = 0;

    -- Reference read: etl.BatchControl
    SELECT @RowCount = COUNT(*) FROM etl.BatchControl WHERE [IsDeleted] = 0;

    -- Reference read: stg.OrderStage
    SELECT @RowCount = COUNT(*) FROM stg.OrderStage WHERE [IsDeleted] = 0;

    RETURN @RowCount;
END
GO