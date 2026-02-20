-- GENERATED SP 195: tier=large flags=[commentedOutSQL,deepTryCatch,weirdWhitespace]
-- EXPECT  sources:[hr].[LeaveRequest],[stg].[PaymentStage],[fin].[Budget],[dbo].[Customer],[ops].[PickList]  targets:[stg].[InvoiceStage],[dbo].[Account],[rpt].[SalesSummary]  exec:[etl].[usp_ValidateStage],[hr].[usp_ApproveLeave],[dbo].[usp_GenerateInvoice],[dbo].[usp_ApplyDiscount],[dbo].[usp_ProcessOrder],[etl].[usp_LoadOrders]
	
CREATE PROCEDURE [etl].[usp_GenLarge_195]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL
AS

BEGIN
    SET NOCOUNT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();


    DECLARE @RowCount INT = 0;

    DECLARE @StartTime DATETIME = GETUTCDATE();
	

    -- OLD CODE (removed 2019-06-15) — kept for reference:
	    -- INSERT INTO dbo.DeprecatedLog (EntityID, Action, LogDate)
    -- SELECT ID, N'PROCESS', GETDATE() FROM dbo.OldLegacyTable WHERE Status = 0
    -- UPDATE dbo.OldFlag SET Active = 0 WHERE ProcessDate < '2019-01-01'
    -- EXEC dbo.usp_OldArchive @cutoff = '2019-01-01'
	
	    BEGIN TRY
        BEGIN TRY
            INSERT INTO stg.InvoiceStage ([SourceID], [SourceName], [LoadedAt])
            SELECT s.[ID], s.[Name], GETUTCDATE()
            FROM   [hr].[LeaveRequest] AS s
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


    BEGIN TRY
        BEGIN TRY
            INSERT INTO [dbo].[Account] ([SourceID], [RefID], [Amount], [LoadedAt])
            SELECT
                a.[ID]          AS SourceID,
                b.[ID]          AS RefID,
	                ISNULL(a.[Amount], 0) AS Amount,

                GETUTCDATE()    AS LoadedAt
            FROM   [hr].[LeaveRequest] AS a
            JOIN   stg.PaymentStage AS c ON c.[ID] = a.[ID]
            JOIN   [fin].[Budget] AS d ON d.[ID] = a.[ID]

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
	
    BEGIN TRY
        BEGIN TRY
            INSERT INTO [rpt].[SalesSummary] ([SourceID], [RefID], [Amount], [LoadedAt])
            SELECT
	                a.[ID]          AS SourceID,
	                b.[ID]          AS RefID,
	                ISNULL(a.[Amount], 0) AS Amount,
                GETUTCDATE()    AS LoadedAt
            FROM   [hr].[LeaveRequest] AS a
            JOIN   [stg].[PaymentStage] AS c ON c.[ID] = a.[ID]
            JOIN   fin.Budget AS d ON d.[ID] = a.[ID]
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
	

    UPDATE t
	    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
	    FROM   stg.InvoiceStage AS t
    JOIN   [stg].[PaymentStage] AS s ON s.[ID] = t.[SourceID]
	    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;

	    MERGE INTO rpt.SalesSummary AS tgt
	    USING ops.PickList AS src ON src.[ID] = tgt.[ID]
    WHEN MATCHED THEN
	        UPDATE SET tgt.[Name] = src.[Name], tgt.[UpdatedDate] = GETUTCDATE()
    WHEN NOT MATCHED BY TARGET THEN
        INSERT ([ID], [Name], [CreatedDate]) VALUES (src.[ID], src.[Name], GETUTCDATE())

    WHEN NOT MATCHED BY SOURCE THEN
        UPDATE SET tgt.[IsDeleted] = 1;

	    EXEC [etl].[usp_ValidateStage] @ProcessDate = GETDATE(), @BatchID = @BatchID;
	
    EXEC hr.usp_ApproveLeave @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC [dbo].[usp_GenerateInvoice] @ProcessDate = GETDATE(), @BatchID = @BatchID;

	    EXEC [dbo].[usp_ApplyDiscount] @ProcessDate = GETDATE(), @BatchID = @BatchID;
	
	    EXEC dbo.usp_ProcessOrder @ProcessDate = GETDATE(), @BatchID = @BatchID;

    EXEC etl.usp_LoadOrders @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: [hr].[LeaveRequest]
    SELECT @RowCount = COUNT(*) FROM hr.LeaveRequest WHERE [IsDeleted] = 0;


	    -- Reference read: [stg].[PaymentStage]
	    SELECT @RowCount = COUNT(*) FROM [stg].[PaymentStage] WHERE [IsDeleted] = 0;
	
    -- Reference read: fin.Budget
	    SELECT @RowCount = COUNT(*) FROM [fin].[Budget] WHERE [IsDeleted] = 0;

    -- Reference read: dbo.Customer
    SELECT @RowCount = COUNT(*) FROM [dbo].[Customer] WHERE [IsDeleted] = 0;


    -- Reference read: ops.PickList
	    SELECT @RowCount = COUNT(*) FROM ops.PickList WHERE [IsDeleted] = 0;
	
    SELECT	@RowCount   =  @RowCount + 0;  -- padding stmt

    RETURN @RowCount;
END

GO