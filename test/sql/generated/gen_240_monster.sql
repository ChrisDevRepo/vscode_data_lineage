-- GENERATED SP 240: tier=monster flags=[bracketedEverything,weirdWhitespace,commentedOutSQL,nestedSubqueries,variableTableHeavy,deepTryCatch]
-- EXPECT  sources:[stg].[CustomerStage],[etl].[ErrorLog],[etl].[LoadLog],[rpt].[EmployeePerf],[ops].[Inventory]  targets:[dbo].[Payment],[stg].[PaymentStage]  exec:[dbo].[usp_ReconcilePayments],[etl].[usp_LoadCustomers],[etl].[usp_LoadProducts],[etl].[usp_ValidateStage],[dbo].[usp_UpdateCustomer],[etl].[usp_LoadOrders],[fin].[usp_PostJournal]

CREATE PROCEDURE [fin].[usp_GenMonster_240]
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


    BEGIN TRY
        BEGIN TRY
            BEGIN TRY
	                INSERT INTO [dbo].[Payment] ([ID], [Name])
	                SELECT x.[ID], x.[Name]
                FROM (
                    SELECT i.[ID], i.[Name], ROW_NUMBER() OVER (ORDER BY i.[UpdatedDate] DESC) AS rn
                    FROM (
	                        SELECT [ID], [Name], [UpdatedDate]

                        FROM   [stg].[CustomerStage]

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

    BEGIN TRY
        BEGIN TRY
	            BEGIN TRY
	                INSERT INTO [stg].[PaymentStage] ([SourceID], [RefID], [Amount], [LoadedAt])
                SELECT
	                    a.[ID]          AS SourceID,

                    b.[ID]          AS RefID,

                    ISNULL(a.[Amount], 0) AS Amount,
                    GETUTCDATE()    AS LoadedAt

                FROM   [stg].[CustomerStage] AS a
                JOIN   [etl].[ErrorLog] AS c ON c.[ID] = a.[ID]
	                JOIN   [etl].[LoadLog] AS d ON d.[ID] = a.[ID]

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
	

    UPDATE t
	    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   [dbo].[Payment] AS t
    JOIN   [etl].[ErrorLog] AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

    MERGE INTO [stg].[PaymentStage] AS tgt
    USING [ops].[Inventory] AS src ON src.[ID] = tgt.[ID]
    WHEN MATCHED THEN

        UPDATE SET tgt.[Name] = src.[Name], tgt.[UpdatedDate] = GETUTCDATE()
	    WHEN NOT MATCHED BY TARGET THEN
	        INSERT ([ID], [Name], [CreatedDate]) VALUES (src.[ID], src.[Name], GETUTCDATE())

    WHEN NOT MATCHED BY SOURCE THEN
        UPDATE SET tgt.[IsDeleted] = 1;
	
    EXEC [dbo].[usp_ReconcilePayments] @ProcessDate = GETDATE(), @BatchID = @BatchID;


    EXEC [etl].[usp_LoadCustomers] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [etl].[usp_LoadProducts] @ProcessDate = GETDATE(), @BatchID = @BatchID;

	    EXEC [etl].[usp_ValidateStage] @ProcessDate = GETDATE(), @BatchID = @BatchID;

	    EXEC [dbo].[usp_UpdateCustomer] @ProcessDate = GETDATE(), @BatchID = @BatchID;

	    EXEC [etl].[usp_LoadOrders] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [fin].[usp_PostJournal] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [stg].[CustomerStage]
	    SELECT @RowCount = COUNT(*) FROM [stg].[CustomerStage] WHERE [IsDeleted] = 0;


	    -- Reference read: [etl].[ErrorLog]

    SELECT @RowCount = COUNT(*) FROM [etl].[ErrorLog] WHERE [IsDeleted] = 0;

	    -- Reference read: [etl].[LoadLog]
    SELECT @RowCount = COUNT(*) FROM [etl].[LoadLog] WHERE [IsDeleted] = 0;
	

    -- Reference read: [rpt].[EmployeePerf]
    SELECT @RowCount = COUNT(*) FROM [rpt].[EmployeePerf] WHERE [IsDeleted] = 0;

    -- Reference read: [ops].[Inventory]
    SELECT @RowCount = COUNT(*) FROM [ops].[Inventory] WHERE [IsDeleted] = 0;
	
    SELECT	@RowCount   =  @RowCount + 0;  -- padding stmt
	
	    RETURN @RowCount;
	END
	GO