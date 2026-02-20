
CREATE PROCEDURE DataLoadSimulation.CreateCustomerOrders
@CurrentDateTime datetime2(7),
@StartingWhen datetime,
@EndOfTime datetime2(7),
@NumberOfCustomerOrders int,
@IsSilentMode bit
WITH EXECUTE AS OWNER
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    -- Pushed Notifications to calling proc
    --IF @IsSilentMode = 0
    --BEGIN
    --    PRINT N'Creating ' + CAST(@NumberOfCustomerOrders AS nvarchar(20)) + N' customer orders for ' + LEFT(CAST(@CurrentDateTime AS NVARCHAR), 10);
    --END;

    DECLARE @OrderCounter int = 0;
    DECLARE @OrderLineCounter int = 0;
    DECLARE @CustomerID int;
    DECLARE @OrderID int;
    DECLARE @PrimaryContactPersonID int;
    DECLARE @SalespersonPersonID int;
    DECLARE @ExpectedDeliveryDate date = DATEADD(day, 1, @CurrentDateTime);
    DECLARE @OrderDateTime datetime = @StartingWhen;
    DECLARE @NumberOfOrderLines int;
    DECLARE @StockItemID int;
    DECLARE @StockItemName nvarchar(100);
    DECLARE @UnitPackageID int;
    DECLARE @QuantityPerOuter int;
    DECLARE @Quantity int;
    DECLARE @CustomerPrice decimal(18,2);
    DECLARE @TaxRate decimal(18,3);

    -- No deliveries on weekends

    SET DATEFIRST 7;

    WHILE DATEPART(weekday, @ExpectedDeliveryDate) IN (1, 7)
    BEGIN
        SET @ExpectedDeliveryDate = DATEADD(day, 1, @ExpectedDeliveryDate);
    END;

    -- Generate the required orders

    WHILE @OrderCounter < @NumberOfCustomerOrders
    BEGIN

        BEGIN TRAN;

        SET @OrderID = NEXT VALUE FOR Sequences.OrderID;

        -- SELECT TOP(1) @CustomerID = c.CustomerID,
        --               @PrimaryContactPersonID = c.PrimaryContactPersonID
        -- FROM Sales.Customers AS c
        -- WHERE c.IsOnCreditHold = 0
        -- ORDER BY NEWID();
        EXEC [DataLoadSimulation].[GetRandomCustomer]
            @RandomCustomerID = @CustomerID  OUTPUT
          , @CustomerPrimaryContactPersonID = @PrimaryContactPersonID OUTPUT


        -- SET @SalespersonPersonID = (SELECT TOP(1) PersonID
        --                             FROM [Application].People
        --                             WHERE IsSalesperson <> 0
        --                             ORDER BY NEWID());
        EXEC [DataLoadSimulation].[GetRandomSalesPersonID]
          @RandomSalesPersonID = @SalespersonPersonID OUTPUT

        INSERT Sales.Orders
            (OrderID, CustomerID, SalespersonPersonID, PickedByPersonID, ContactPersonID, BackorderOrderID, OrderDate,
             ExpectedDeliveryDate, CustomerPurchaseOrderNumber, IsUndersupplyBackordered, Comments, DeliveryInstructions, InternalComments,
             PickingCompletedWhen, LastEditedBy, LastEditedWhen)
        VALUES
            (@OrderID, @CustomerID, @SalespersonPersonID, NULL, @PrimaryContactPersonID, NULL, @CurrentDateTime,
             @ExpectedDeliveryDate, CAST(CEILING(RAND() * 10000) + 10000 AS nvarchar(20)), 1, NULL, NULL, NULL,
             NULL, 1, @OrderDateTime);

        SET @NumberOfOrderLines = 1 + CEILING(RAND() * 4);
        SET @OrderLineCounter = 0;

        WHILE @OrderLineCounter < @NumberOfOrderLines
        BEGIN
            SELECT TOP(1) @StockItemID = si.StockItemID,
                          @StockItemName = si.StockItemName,
                          @UnitPackageID = si.UnitPackageID,
                          @QuantityPerOuter = si.QuantityPerOuter,
                          @TaxRate = si.TaxRate
            FROM Warehouse.StockItems AS si
            WHERE NOT EXISTS (SELECT 1 FROM Sales.OrderLines AS ol
                                       WHERE ol.OrderID = @OrderID
                                       AND ol.StockItemID = si.StockItemID)
            ORDER BY NEWID();

            SET @Quantity = @QuantityPerOuter * (1 + FLOOR(RAND() * 10));
            SET @CustomerPrice = Website.CalculateCustomerPrice(@CustomerID, @StockItemID, @CurrentDateTime);

            INSERT Sales.OrderLines
                (OrderID, StockItemID, [Description], PackageTypeID, Quantity, UnitPrice,
                 TaxRate, PickedQuantity, PickingCompletedWhen, LastEditedBy, LastEditedWhen)
            VALUES
                (@OrderID, @StockItemID, @StockItemName, @UnitPackageID, @Quantity, @CustomerPrice,
                 @TaxRate, 0, NULL, 1, @StartingWhen);

            SET @OrderLineCounter += 1;
        END;

        COMMIT;

        SET @OrderCounter += 1;
    END;
END;