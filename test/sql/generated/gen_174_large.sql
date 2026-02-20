-- GENERATED SP 174: tier=large flags=[weirdWhitespace,deepTryCatch,massiveComments]
-- EXPECT  sources:[dbo].[Payment],[dbo].[PriceList],[ops].[Shipment]  targets:[dbo].[Invoice],[ops].[ReturnOrder],[dbo].[Shipper]  exec:[fin].[usp_PostJournal],[hr].[usp_ApproveLeave],[dbo].[usp_ArchiveOrders],[dbo].[usp_UpdateCustomer],[dbo].[usp_ProcessOrder]
	
CREATE PROCEDURE [ops].[usp_GenLarge_174]
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
            INSERT INTO dbo.Invoice ([SourceID], [SourceName], [LoadedAt])
	            SELECT s.[ID], s.[Name], GETUTCDATE()
            FROM   dbo.Payment AS s

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
            INSERT INTO ops.ReturnOrder ([SourceID], [RefID], [Amount], [LoadedAt])
            SELECT

                a.[ID]          AS SourceID,
                b.[ID]          AS RefID,
                ISNULL(a.[Amount], 0) AS Amount,
                GETUTCDATE()    AS LoadedAt
            FROM   [dbo].[Payment] AS a
            JOIN   dbo.PriceList AS c ON c.[ID] = a.[ID]
	            JOIN   ops.Shipment AS d ON d.[ID] = a.[ID]
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
    BEGIN TRY
	        BEGIN TRY
            INSERT INTO [dbo].[Shipper] ([SourceID], [RefID], [Amount], [LoadedAt])
            SELECT
	                a.[ID]          AS SourceID,
                b.[ID]          AS RefID,
	                ISNULL(a.[Amount], 0) AS Amount,
	                GETUTCDATE()    AS LoadedAt
            FROM   dbo.Payment AS a
	            JOIN   dbo.PriceList AS c ON c.[ID] = a.[ID]
            JOIN   [ops].[Shipment] AS d ON d.[ID] = a.[ID]
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
	    UPDATE t
    SET    t.[Status]      = s.[Status],
	           t.[UpdatedDate] = GETUTCDATE()
    FROM   [dbo].[Invoice] AS t
    JOIN   dbo.PriceList AS s ON s.[ID] = t.[SourceID]
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
    MERGE INTO [dbo].[Shipper] AS tgt
    USING ops.Shipment AS src ON src.[ID] = tgt.[ID]
	    WHEN MATCHED THEN
	        UPDATE SET tgt.[Name] = src.[Name], tgt.[UpdatedDate] = GETUTCDATE()
	    WHEN NOT MATCHED BY TARGET THEN
	        INSERT ([ID], [Name], [CreatedDate]) VALUES (src.[ID], src.[Name], GETUTCDATE())
    WHEN NOT MATCHED BY SOURCE THEN
        UPDATE SET tgt.[IsDeleted] = 1;

	    EXEC [fin].[usp_PostJournal] @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [hr].[usp_ApproveLeave] @ProcessDate = GETDATE(), @BatchID = @BatchID;


    EXEC dbo.usp_ArchiveOrders @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC dbo.usp_UpdateCustomer @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [dbo].[usp_ProcessOrder] @ProcessDate = GETDATE(), @BatchID = @BatchID;
	
    -- Reference read: [dbo].[Payment]
    SELECT @RowCount = COUNT(*) FROM dbo.Payment WHERE [IsDeleted] = 0;


    -- Reference read: dbo.PriceList
    SELECT @RowCount = COUNT(*) FROM dbo.PriceList WHERE [IsDeleted] = 0;

    -- Reference read: ops.Shipment
    SELECT @RowCount = COUNT(*) FROM ops.Shipment WHERE [IsDeleted] = 0;

    SELECT	@RowCount   =  @RowCount + 0;  -- padding stmt

	    RETURN @RowCount;
END
	GO