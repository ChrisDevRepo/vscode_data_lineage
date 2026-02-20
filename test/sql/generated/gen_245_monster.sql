-- GENERATED SP 245: tier=monster flags=[weirdWhitespace,noCaps,allCaps,excessiveDeclare,transactionBlocks,deepTryCatch]
-- EXPECT  sources:[hr].[Position],[stg].[CustomerStage],[fin].[TRANSACTION],[dbo].[Shipper],[stg].[ProductStage],[stg].[OrderStage]  targets:[stg].[EmployeeStage],[rpt].[MonthlyOrders]  EXEC:[etl].[usp_LoadOrders],[audit].[usp_LogChange],[etl].[usp_LoadCustomers],[dbo].[usp_ArchiveOrders],[dbo].[usp_ReconcilePayments],[fin].[usp_PostJournal]
	

CREATE PROCEDURE [rpt].[usp_GenMonster_245]
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


    BEGIN TRY
        BEGIN TRY
            BEGIN TRY
                BEGIN TRANSACTION;
                INSERT INTO [stg].[EmployeeStage] ([SourceID], [SourceName], [LoadedAt])
                SELECT s.[ID], s.[Name], GETUTCDATE()
                FROM   [hr].[Position] AS s
	                WHERE  s.[IsDeleted] = 0;
	                IF @@ERROR = 0
                    COMMIT TRANSACTION;
                ELSE

                    ROLLBACK TRANSACTION;
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
                INSERT INTO [rpt].[MonthlyOrders] ([SourceID], [RefID], [Amount], [LoadedAt])
                SELECT
                    a.[ID]          AS SourceID,
                    b.[ID]          AS RefID,

                    ISNULL(a.[Amount], 0) AS Amount,
                    GETUTCDATE()    AS LoadedAt

                FROM   [hr].[Position] AS a

                JOIN   stg.CustomerStage AS c ON c.[ID] = a.[ID]
                JOIN   [fin].[TRANSACTION] AS d ON d.[ID] = a.[ID]
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
    FROM   [stg].[EmployeeStage] AS t
    JOIN   stg.CustomerStage AS s ON s.[ID] = t.[SourceID]
	    WHERE  t.[Status] = N'PENDING';
	    SET @RowCount = @RowCount + @@ROWCOUNT;

	    MERGE INTO [rpt].[MonthlyOrders] AS tgt
	    USING [stg].[OrderStage] AS src ON src.[ID] = tgt.[ID]

    WHEN MATCHED THEN

        UPDATE SET tgt.[Name] = src.[Name], tgt.[UpdatedDate] = GETUTCDATE()

    WHEN NOT MATCHED BY TARGET THEN
	        INSERT ([ID], [Name], [CreatedDate]) VALUES (src.[ID], src.[Name], GETUTCDATE())
	    WHEN NOT MATCHED BY SOURCE THEN

        UPDATE SET tgt.[IsDeleted] = 1;


    EXEC [etl].[usp_LoadOrders] @ProcessDate = GETDATE(), @BatchID = @BatchID;

	    EXEC audit.usp_LogChange @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC etl.usp_LoadCustomers @ProcessDate = GETDATE(), @BatchID = @BatchID;

	    EXEC [dbo].[usp_ArchiveOrders] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [dbo].[usp_ReconcilePayments] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [fin].[usp_PostJournal] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [hr].[Position]
	    SELECT @RowCount = COUNT(*) FROM hr.Position WHERE [IsDeleted] = 0;

    -- Reference read: [stg].[CustomerStage]
	    SELECT @RowCount = COUNT(*) FROM [stg].[CustomerStage] WHERE [IsDeleted] = 0;

    -- Reference read: [fin].[TRANSACTION]
    SELECT @RowCount = COUNT(*) FROM [fin].[TRANSACTION] WHERE [IsDeleted] = 0;

    -- Reference read: dbo.Shipper

    SELECT @RowCount = COUNT(*) FROM dbo.Shipper WHERE [IsDeleted] = 0;
	
    -- Reference read: [stg].[ProductStage]
	    SELECT @RowCount = COUNT(*) FROM [stg].[ProductStage] WHERE [IsDeleted] = 0;

    -- Reference read: [stg].[OrderStage]
	    SELECT @RowCount = COUNT(*) FROM [stg].[OrderStage] WHERE [IsDeleted] = 0;


    SELECT	@RowCount   =  @RowCount + 0;  -- padding stmt
	
	    RETURN @RowCount;
END
GO