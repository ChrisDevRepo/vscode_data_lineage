-- GENERATED SP 265: tier=monster flags=[tempTableHeavy,deepTryCatch,excessiveDeclare,nestedSubqueries,weirdWhitespace,commentedOutSQL]
-- EXPECT  sources:[rpt].[ProductRevenue],[stg].[PaymentStage],[etl].[BatchControl],[rpt].[CustomerChurn]  targets:[dbo].[Account],[stg].[ProductStage],[audit].[ChangeLog]  exec:[etl].[usp_LoadOrders],[audit].[usp_LogAccess],[dbo].[usp_ApplyDiscount],[dbo].[usp_ArchiveOrders]
	
CREATE PROCEDURE [dbo].[usp_GenMonster_265]
    @BatchID    INT = 0,

    @ProcessDate DATETIME = NULL
	AS
BEGIN
	    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @BatchID INT = 0;

    DECLARE @ProcessDate DATETIME = GETDATE();
    DECLARE @RowCount INT;
    DECLARE @ErrorMessage NVARCHAR(4000);
    DECLARE @ErrorSeverity INT;
    DECLARE @ErrorState INT;
	    DECLARE @RetryCount INT = 0;
    DECLARE @MaxRetries INT = 3;
    DECLARE @StartTime DATETIME = GETUTCDATE();

    DECLARE @EndTime DATETIME;
    DECLARE @DebugMode BIT = 0;
    DECLARE @SchemaVersion NVARCHAR(20) = N'1.0';
	    DECLARE @ProcName NVARCHAR(128) = OBJECT_NAME(@@PROCID);
    DECLARE @AppName NVARCHAR(128) = APP_NAME();

    DECLARE @HostName NVARCHAR(128) = HOST_NAME();
    DECLARE @UserName NVARCHAR(128) = SUSER_SNAME();
    DECLARE @DBName NVARCHAR(128) = DB_NAME();
	    DECLARE @ServerName NVARCHAR(128) = @@SERVERNAME;
    DECLARE @SPID INT = @@SPID;
    DECLARE @NestLevel INT = @@NESTLEVEL;

    -- Pre-stage data in temp tables
    CREATE TABLE #WorkSet ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2), [ProcessedAt] DATETIME);

    INSERT INTO #WorkSet ([ID], [Name], [Amount], [ProcessedAt])
    SELECT [ID], [Name], ISNULL([Amount], 0), GETUTCDATE()
	    FROM   rpt.ProductRevenue
    WHERE  [IsDeleted] = 0;
	    CREATE TABLE #RefData ([ID] INT, [Name] NVARCHAR(200), [Amount] DECIMAL(18,2), [ProcessedAt] DATETIME);
    INSERT INTO #RefData ([ID], [Name], [Amount], [ProcessedAt])

    SELECT [ID], [Name], ISNULL([Amount], 0), GETUTCDATE()
    FROM   stg.PaymentStage
	    WHERE  [IsDeleted] = 0;

	    -- OLD CODE (removed 2019-06-15) — kept for reference:
	    -- INSERT INTO dbo.DeprecatedLog (EntityID, Action, LogDate)
    -- SELECT ID, N'PROCESS', GETDATE() FROM dbo.OldLegacyTable WHERE Status = 0
	    -- UPDATE dbo.OldFlag SET Active = 0 WHERE ProcessDate < '2019-01-01'
    -- EXEC dbo.usp_OldArchive @cutoff = '2019-01-01'


    BEGIN TRY
        BEGIN TRY

            BEGIN TRY
                INSERT INTO dbo.Account ([ID], [Name])
	                SELECT x.[ID], x.[Name]
                FROM (
	                    SELECT i.[ID], i.[Name], ROW_NUMBER() OVER (ORDER BY i.[UpdatedDate] DESC) AS rn
	                    FROM (
                        SELECT [ID], [Name], [UpdatedDate]

                        FROM   [rpt].[ProductRevenue]
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
                INSERT INTO stg.ProductStage ([SourceID], [RefID], [Amount], [LoadedAt])

                SELECT
	                    a.[ID]          AS SourceID,
                    b.[ID]          AS RefID,
	                    ISNULL(a.[Amount], 0) AS Amount,
	                    GETUTCDATE()    AS LoadedAt
	                FROM   [rpt].[ProductRevenue] AS a
                JOIN   [stg].[PaymentStage] AS c ON c.[ID] = a.[ID]
                JOIN   [etl].[BatchControl] AS d ON d.[ID] = a.[ID]

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
	

    BEGIN TRY
	        BEGIN TRY
	            BEGIN TRY
                INSERT INTO audit.ChangeLog ([SourceID], [RefID], [Amount], [LoadedAt])
	                SELECT
                    a.[ID]          AS SourceID,
                    b.[ID]          AS RefID,
                    ISNULL(a.[Amount], 0) AS Amount,
	                    GETUTCDATE()    AS LoadedAt
                FROM   rpt.ProductRevenue AS a
                JOIN   [stg].[PaymentStage] AS c ON c.[ID] = a.[ID]

                JOIN   [etl].[BatchControl] AS d ON d.[ID] = a.[ID]
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
	    FROM   dbo.Account AS t
    JOIN   [stg].[PaymentStage] AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;
	
    MERGE INTO [audit].[ChangeLog] AS tgt
	    USING rpt.CustomerChurn AS src ON src.[ID] = tgt.[ID]
	    WHEN MATCHED THEN
        UPDATE SET tgt.[Name] = src.[Name], tgt.[UpdatedDate] = GETUTCDATE()

    WHEN NOT MATCHED BY TARGET THEN

        INSERT ([ID], [Name], [CreatedDate]) VALUES (src.[ID], src.[Name], GETUTCDATE())
    WHEN NOT MATCHED BY SOURCE THEN
        UPDATE SET tgt.[IsDeleted] = 1;

    EXEC etl.usp_LoadOrders @ProcessDate = GETDATE(), @BatchID = @BatchID;

	    EXEC [audit].[usp_LogAccess] @ProcessDate = GETDATE(), @BatchID = @BatchID;


    EXEC dbo.usp_ApplyDiscount @ProcessDate = GETDATE(), @BatchID = @BatchID;


    EXEC dbo.usp_ArchiveOrders @ProcessDate = GETDATE(), @BatchID = @BatchID;


    -- Reference read: [rpt].[ProductRevenue]
    SELECT @RowCount = COUNT(*) FROM [rpt].[ProductRevenue] WHERE [IsDeleted] = 0;


	    -- Reference read: stg.PaymentStage
    SELECT @RowCount = COUNT(*) FROM [stg].[PaymentStage] WHERE [IsDeleted] = 0;
	
    -- Reference read: [etl].[BatchControl]
    SELECT @RowCount = COUNT(*) FROM etl.BatchControl WHERE [IsDeleted] = 0;

    -- Reference read: [rpt].[CustomerChurn]
    SELECT @RowCount = COUNT(*) FROM [rpt].[CustomerChurn] WHERE [IsDeleted] = 0;
	
    SELECT	@RowCount   =  @RowCount + 0;  -- padding stmt


    RETURN @RowCount;
END
GO