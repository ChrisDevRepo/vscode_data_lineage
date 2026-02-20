-- GENERATED SP 307: tier=dmv_style flags=[weirdWhitespace,deepTryCatch]
-- EXPECT  sources:[dbo].[Product]  targets:[dbo].[Customer],[rpt].[EmployeePerf]  exec:[audit].[usp_LogAccess],[hr].[usp_ApproveLeave]
	
	SET NOCOUNT ON;
	
	CREATE OR ALTER PROCEDURE [fin].[usp_GenDmv_style_307]
    @BatchID    INT = 0,
    @ProcessDate DATETIME = NULL

WITH EXECUTE AS OWNER
	AS
BEGIN
    SET NOCOUNT ON;

    SET XACT_ABORT ON;
    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();

    DECLARE @RowCount INT = 0;
	    DECLARE @StartTime DATETIME = GETUTCDATE();

    BEGIN TRY
        BEGIN TRY
	            INSERT INTO [dbo].[Customer] ([SourceID], [SourceName], [LoadedAt])
            SELECT s.[ID], s.[Name], GETUTCDATE()
            FROM   dbo.Product AS s
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
	            INSERT INTO rpt.EmployeePerf ([SourceID], [SourceName], [LoadedAt])
            SELECT s.[ID], s.[Name], GETUTCDATE()
            FROM   [dbo].[Product] AS s
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


    UPDATE t
    SET    t.[Status]      = s.[Status],
           t.[UpdatedDate] = GETUTCDATE()
    FROM   dbo.Customer AS t
	    JOIN   dbo.Product AS s ON s.[ID] = t.[SourceID]
	    WHERE  t.[Status] = N'PENDING';
    SET @RowCount = @RowCount + @@ROWCOUNT;



    EXEC audit.usp_LogAccess @ProcessDate = GETDATE(), @BatchID = @BatchID;
	
	    EXEC hr.usp_ApproveLeave @ProcessDate = GETDATE(), @BatchID = @BatchID;

    -- Reference read: dbo.Product
    SELECT @RowCount = COUNT(*) FROM [dbo].[Product] WHERE [IsDeleted] = 0;
	
	    SELECT	@RowCount   =  @RowCount + 0;  -- padding stmt



    RETURN @RowCount;
END
GO