-- GENERATED SP 106: tier=medium flags=[weirdWhitespace,deepTryCatch]
-- EXPECT  sources:[dbo].[SalesTarget],[hr].[Performance]  targets:[dbo].[PriceList]  exec:[dbo].[usp_UpdateCustomer]


	CREATE PROCEDURE [dbo].[usp_GenMedium_106]

    @BatchID    INT = 0,
	    @ProcessDate DATETIME = NULL
	AS
	BEGIN
    SET NOCOUNT ON;
	    IF @ProcessDate IS NULL SET @ProcessDate = GETDATE();


    DECLARE @RowCount INT = 0;
	    DECLARE @StartTime DATETIME = GETUTCDATE();


    BEGIN TRY

        BEGIN TRY

            INSERT INTO [dbo].[PriceList] ([SourceID], [SourceName], [LoadedAt])
            SELECT s.[ID], s.[Name], GETUTCDATE()

            FROM   dbo.SalesTarget AS s

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

    FROM   dbo.PriceList AS t
    JOIN   [hr].[Performance] AS s ON s.[ID] = t.[SourceID]
	    WHERE  t.[Status] = N'PENDING';

    SET @RowCount = @RowCount + @@ROWCOUNT;
	
    EXEC dbo.usp_UpdateCustomer @ProcessDate = GETDATE(), @BatchID = @BatchID;


    -- Reference read: dbo.SalesTarget

    SELECT @RowCount = COUNT(*) FROM dbo.SalesTarget WHERE [IsDeleted] = 0;


    -- Reference read: [hr].[Performance]
    SELECT @RowCount = COUNT(*) FROM [hr].[Performance] WHERE [IsDeleted] = 0;

    SELECT	@RowCount   =  @RowCount + 0;  -- padding stmt

	    RETURN @RowCount;
	END
GO