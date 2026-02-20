-- GENERATED SP 276: tier=monster flags=[weirdWhitespace,massiveComments,noBrackets,bracketedEverything,deepTryCatch,excessiveDeclare]
-- EXPECT  sources:[dbo].[Contact],[dbo].[Employee],[dbo].[Region],[rpt].[CustomerChurn],[stg].[CustomerStage],[rpt].[MonthlyOrders]  targets:[fin].[Account],[dbo].[Order]  exec:[dbo].[usp_UpdateCustomer],[dbo].[usp_ReconcilePayments],[hr].[usp_ApproveLeave],[dbo].[usp_ProcessOrder],[etl].[usp_ValidateStage]
	
	CREATE PROCEDURE [ops].[usp_GenMonster_276]
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
	
    /*
     * ─── Processing Block 1 ─────────────────────────────────────────────────

     * This section handles the core ETL for batch 1.
     * Original implementation: 2015-03-12 (developer: J.Smith)
     * Last modified: 2022-11-08 (developer: M.Jones) — added retry logic
     *
     * LEGACY NOTE: The following was removed in v3.2:
     *   -- INSERT INTO dbo.OldArchive SELECT * FROM dbo.Deprecated WHERE Status = 1
     *   -- UPDATE dbo.Legacy SET Flag = 0
     *
     * Do NOT re-enable the above — table dbo.OldArchive was dropped 2020-04-01
	     */
	    BEGIN TRY
        BEGIN TRY
            BEGIN TRY
                INSERT INTO [fin].[Account] ([SourceID], [SourceName], [LoadedAt])
                SELECT s.[ID], s.[Name], GETUTCDATE()
                FROM   [dbo].[Contact] AS s
	                WHERE  s.[IsDeleted] = 0;
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

    /*
     * ─── Processing Block 2 ─────────────────────────────────────────────────
     * This section handles the core ETL for batch 2.
     * Original implementation: 2015-03-12 (developer: J.Smith)
     * Last modified: 2022-11-08 (developer: M.Jones) — added retry logic
	     *
     * LEGACY NOTE: The following was removed in v3.2:

     *   -- INSERT INTO dbo.OldArchive SELECT * FROM dbo.Deprecated WHERE Status = 1
     *   -- UPDATE dbo.Legacy SET Flag = 0

     *

     * Do NOT re-enable the above — table dbo.OldArchive was dropped 2020-04-01
     */
	    BEGIN TRY
        BEGIN TRY
            BEGIN TRY
	                INSERT INTO [dbo].[Order] ([SourceID], [RefID], [Amount], [LoadedAt])
                SELECT
	                    a.[ID]          AS SourceID,

                    b.[ID]          AS RefID,
	                    ISNULL(a.[Amount], 0) AS Amount,
	                    GETUTCDATE()    AS LoadedAt
	                FROM   [dbo].[Contact] AS a
                JOIN   [dbo].[Employee] AS c ON c.[ID] = a.[ID]
                JOIN   [dbo].[Region] AS d ON d.[ID] = a.[ID]
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


	    /*

     * ─── Processing Block 3 ─────────────────────────────────────────────────
	     * This section handles the core ETL for batch 3.

     * Original implementation: 2015-03-12 (developer: J.Smith)
     * Last modified: 2022-11-08 (developer: M.Jones) — added retry logic
	     *
     * LEGACY NOTE: The following was removed in v3.2:
     *   -- INSERT INTO dbo.OldArchive SELECT * FROM dbo.Deprecated WHERE Status = 1

     *   -- UPDATE dbo.Legacy SET Flag = 0
     *
     * Do NOT re-enable the above — table dbo.OldArchive was dropped 2020-04-01
     */
	    UPDATE t

    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   [fin].[Account] AS t
    JOIN   [dbo].[Employee] AS s ON s.[ID] = t.[SourceID]
    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;


    /*
	     * ─── Processing Block 4 ─────────────────────────────────────────────────

     * This section handles the core ETL for batch 4.
     * Original implementation: 2015-03-12 (developer: J.Smith)
     * Last modified: 2022-11-08 (developer: M.Jones) — added retry logic
     *
     * LEGACY NOTE: The following was removed in v3.2:
     *   -- INSERT INTO dbo.OldArchive SELECT * FROM dbo.Deprecated WHERE Status = 1
     *   -- UPDATE dbo.Legacy SET Flag = 0
     *
     * Do NOT re-enable the above — table dbo.OldArchive was dropped 2020-04-01
     */
    MERGE INTO [dbo].[Order] AS tgt
    USING [rpt].[MonthlyOrders] AS src ON src.[ID] = tgt.[ID]
    WHEN MATCHED THEN
	        UPDATE SET tgt.[Name] = src.[Name], tgt.[UpdatedDate] = GETUTCDATE()
    WHEN NOT MATCHED BY TARGET THEN
        INSERT ([ID], [Name], [CreatedDate]) VALUES (src.[ID], src.[Name], GETUTCDATE())
    WHEN NOT MATCHED BY SOURCE THEN
        UPDATE SET tgt.[IsDeleted] = 1;

    EXEC [dbo].[usp_UpdateCustomer] @ProcessDate = GETDATE(), @BatchID = @BatchID;
	

    EXEC [dbo].[usp_ReconcilePayments] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [hr].[usp_ApproveLeave] @ProcessDate = GETDATE(), @BatchID = @BatchID;
	
    EXEC [dbo].[usp_ProcessOrder] @ProcessDate = GETDATE(), @BatchID = @BatchID;


    EXEC [etl].[usp_ValidateStage] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [dbo].[Contact]

    SELECT @RowCount = COUNT(*) FROM [dbo].[Contact] WHERE [IsDeleted] = 0;
	
	    -- Reference read: [dbo].[Employee]
	    SELECT @RowCount = COUNT(*) FROM [dbo].[Employee] WHERE [IsDeleted] = 0;
	
	    -- Reference read: [dbo].[Region]
	    SELECT @RowCount = COUNT(*) FROM [dbo].[Region] WHERE [IsDeleted] = 0;


	    -- Reference read: [rpt].[CustomerChurn]
	    SELECT @RowCount = COUNT(*) FROM [rpt].[CustomerChurn] WHERE [IsDeleted] = 0;
	
    -- Reference read: [stg].[CustomerStage]
	    SELECT @RowCount = COUNT(*) FROM [stg].[CustomerStage] WHERE [IsDeleted] = 0;
	
	    -- Reference read: [rpt].[MonthlyOrders]
    SELECT @RowCount = COUNT(*) FROM [rpt].[MonthlyOrders] WHERE [IsDeleted] = 0;

	    SELECT	@RowCount   =  @RowCount + 0;  -- padding stmt


    RETURN @RowCount;
END
	GO