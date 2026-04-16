-- TRY/CATCH Pattern 01: Triple-nested TRY/CATCH with tables in each level
-- EXPECT  sources:[dbo].[OrderQueue],[dbo].[Product],[dbo].[Customer]  targets:[dbo].[ProcessedOrder],[dbo].[OrderError],[dbo].[FatalError]  exec:[dbo].[usp_NotifyOps]

BEGIN TRANSACTION;

BEGIN TRY

    -- Outer try: full order processing
    DECLARE @OrderID    INT;
    DECLARE @ProductID  INT;
    DECLARE @CustomerID INT;
    DECLARE @Qty        INT;
    DECLARE @UnitPrice  DECIMAL(18,2);

    SELECT TOP 1
        @OrderID    = [OrderID],
        @ProductID  = [ProductID],
        @CustomerID = [CustomerID],
        @Qty        = [Quantity],
        @UnitPrice  = [UnitPrice]
    FROM [dbo].[OrderQueue]
    WHERE [Status] = N'PENDING'
    ORDER BY [Priority] DESC, [CreatedAt] ASC;

    BEGIN TRY

        -- Inner try: product/customer validation
        DECLARE @StockQty   INT;
        DECLARE @CreditLimit DECIMAL(18,2);

        SELECT @StockQty = [StockQty]
        FROM   [dbo].[Product]
        WHERE  [ProductID] = @ProductID;

        SELECT @CreditLimit = [CreditLimit]
        FROM   [dbo].[Customer]
        WHERE  [CustomerID] = @CustomerID;

        IF @StockQty < @Qty
            THROW 50001, 'Insufficient stock', 1;

        IF @CreditLimit < (@Qty * @UnitPrice)
            THROW 50002, 'Credit limit exceeded', 1;

        BEGIN TRY
            -- Innermost try: atomic write
            INSERT INTO [dbo].[ProcessedOrder] (
                [OrderID],[ProductID],[CustomerID],[Quantity],[UnitPrice],[ProcessedAt],[Status]
            )
            VALUES (
                @OrderID,@ProductID,@CustomerID,@Qty,@UnitPrice,GETUTCDATE(),N'SUCCESS'
            );

            UPDATE [dbo].[OrderQueue]
            SET    [Status] = N'DONE', [ProcessedAt] = GETUTCDATE()
            WHERE  [OrderID] = @OrderID;

        END TRY
        BEGIN CATCH
            -- Innermost catch: log transient write error
            INSERT INTO [dbo].[OrderError] ([OrderID],[ErrorCode],[ErrorMsg],[OccurredAt],[Severity])
            VALUES (@OrderID, ERROR_NUMBER(), ERROR_MESSAGE(), GETUTCDATE(), N'WRITE_FAIL');
            THROW;
        END CATCH;

    END TRY
    BEGIN CATCH
        -- Inner catch: validation error
        INSERT INTO [dbo].[OrderError] ([OrderID],[ErrorCode],[ErrorMsg],[OccurredAt],[Severity])
        VALUES (@OrderID, ERROR_NUMBER(), ERROR_MESSAGE(), GETUTCDATE(), N'VALIDATION');
        THROW;
    END CATCH;

    COMMIT TRANSACTION;

END TRY
BEGIN CATCH

    -- Outer catch: fatal error handling
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;

    INSERT INTO [dbo].[FatalError] ([Context],[OrderID],[ErrorCode],[ErrorMsg],[OccurredAt])
    VALUES (N'ProcessOrder', @OrderID, ERROR_NUMBER(), ERROR_MESSAGE(), GETUTCDATE());

    EXEC [dbo].[usp_NotifyOps]
        @Severity = N'CRITICAL',
        @Message  = ERROR_MESSAGE(),
        @OrderID  = @OrderID;

END CATCH;
