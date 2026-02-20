-- GENERATED SP 275: tier=monster flags=[weirdWhitespace,massiveComments,transactionBlocks,noBrackets,deepTryCatch,printStatements]
-- EXPECT  sources:[dbo].[Shipper],[dbo].[Account],[fin].[CostCenter],[dbo].[Invoice],[hr].[Department]  targets:[dbo].[Transaction],[hr].[Performance],[fin].[Account]  exec:[audit].[usp_LogChange],[etl].[usp_ValidateStage],[etl].[usp_LoadProducts],[etl].[usp_LoadCustomers],[dbo].[usp_GenerateInvoice],[dbo].[usp_ApplyDiscount],[fin].[usp_PostJournal]
	

CREATE PROCEDURE [ops].[usp_GenMonster_275]
    @BatchID    INT = 0,

    @ProcessDate DATETIME = NULL
	AS

BEGIN
	    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
    DECLARE @StartTime DATETIME = GETUTCDATE();
	
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
                BEGIN TRANSACTION;
                INSERT INTO dbo.Transaction ([SourceID], [SourceName], [LoadedAt])
	                SELECT s.[ID], s.[Name], GETUTCDATE()
                FROM   dbo.Shipper AS s
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
	
    PRINT N'Step 1: Processing batch @BatchID = ' + CAST(@BatchID AS NVARCHAR) + N', elapsed: ' + CAST(DATEDIFF(ms, @StartTime, GETUTCDATE()) AS NVARCHAR) + N' ms';

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

                INSERT INTO hr.Performance ([SourceID], [RefID], [Amount], [LoadedAt])
	                SELECT
                    a.[ID]          AS SourceID,
                    b.[ID]          AS RefID,
                    ISNULL(a.[Amount], 0) AS Amount,

                    GETUTCDATE()    AS LoadedAt
                FROM   dbo.Shipper AS a
	                JOIN   dbo.Account AS c ON c.[ID] = a.[ID]
                JOIN   fin.CostCenter AS d ON d.[ID] = a.[ID]
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

	    PRINT N'Step 2: Processing batch @BatchID = ' + CAST(@BatchID AS NVARCHAR) + N', elapsed: ' + CAST(DATEDIFF(ms, @StartTime, GETUTCDATE()) AS NVARCHAR) + N' ms';
	
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

    BEGIN TRY
	        BEGIN TRY
            BEGIN TRY
                INSERT INTO fin.Account ([SourceID], [RefID], [Amount], [LoadedAt])
                SELECT

                    a.[ID]          AS SourceID,

                    b.[ID]          AS RefID,
	                    ISNULL(a.[Amount], 0) AS Amount,
	                    GETUTCDATE()    AS LoadedAt
                FROM   dbo.Shipper AS a
                JOIN   dbo.Account AS c ON c.[ID] = a.[ID]

                JOIN   fin.CostCenter AS d ON d.[ID] = a.[ID]
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
    UPDATE t
	    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()

    FROM   dbo.Transaction AS t

    JOIN   dbo.Account AS s ON s.[ID] = t.[SourceID]
	    WHERE  t.[Status] = N'PENDING';

    SET @RowCount = @RowCount + @@ROWCOUNT;

	    /*
	     * ─── Processing Block 5 ─────────────────────────────────────────────────
     * This section handles the core ETL for batch 5.
     * Original implementation: 2015-03-12 (developer: J.Smith)
     * Last modified: 2022-11-08 (developer: M.Jones) — added retry logic
     *
	     * LEGACY NOTE: The following was removed in v3.2:
	     *   -- INSERT INTO dbo.OldArchive SELECT * FROM dbo.Deprecated WHERE Status = 1
     *   -- UPDATE dbo.Legacy SET Flag = 0
     *
     * Do NOT re-enable the above — table dbo.OldArchive was dropped 2020-04-01
     */
	    MERGE INTO fin.Account AS tgt
	    USING hr.Department AS src ON src.[ID] = tgt.[ID]
	    WHEN MATCHED THEN
        UPDATE SET tgt.[Name] = src.[Name], tgt.[UpdatedDate] = GETUTCDATE()

    WHEN NOT MATCHED BY TARGET THEN

        INSERT ([ID], [Name], [CreatedDate]) VALUES (src.[ID], src.[Name], GETUTCDATE())
	    WHEN NOT MATCHED BY SOURCE THEN
        UPDATE SET tgt.[IsDeleted] = 1;


    EXEC audit.usp_LogChange @ProcessDate = GETDATE(), @BatchID = @BatchID;


    EXEC etl.usp_ValidateStage @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC etl.usp_LoadProducts @ProcessDate = GETDATE(), @BatchID = @BatchID;


    EXEC etl.usp_LoadCustomers @ProcessDate = GETDATE(), @BatchID = @BatchID;
	
	    EXEC dbo.usp_GenerateInvoice @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC dbo.usp_ApplyDiscount @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC fin.usp_PostJournal @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: dbo.Shipper
	    SELECT @RowCount = COUNT(*) FROM dbo.Shipper WHERE [IsDeleted] = 0;
	
    -- Reference read: dbo.Account

    SELECT @RowCount = COUNT(*) FROM dbo.Account WHERE [IsDeleted] = 0;


    -- Reference read: fin.CostCenter
    SELECT @RowCount = COUNT(*) FROM fin.CostCenter WHERE [IsDeleted] = 0;

    -- Reference read: dbo.Invoice
    SELECT @RowCount = COUNT(*) FROM dbo.Invoice WHERE [IsDeleted] = 0;
	
	    -- Reference read: hr.Department
    SELECT @RowCount = COUNT(*) FROM hr.Department WHERE [IsDeleted] = 0;

    SELECT	@RowCount   =  @RowCount + 0;  -- padding stmt

	    RETURN @RowCount;
END
	GO