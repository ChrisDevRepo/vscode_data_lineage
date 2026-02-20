
CREATE PROCEDURE DataLoadSimulation.PickStockForCustomerOrders
@CurrentDateTime datetime2(7),
@StartingWhen datetime,
@EndOfTime datetime2(7),
@IsSilentMode bit
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    -- Pushed Notifications to calling proc
    --IF @IsSilentMode = 0
    --BEGIN
    --    PRINT N'Picking stock for customer orders for ' + LEFT(CAST(@CurrentDateTime AS NVARCHAR), 10);
    --END;

    SET XACT_ABORT ON;

    DECLARE @UninvoicedOrders TABLE
    (
        OrderID int PRIMARY KEY
    );

    INSERT @UninvoicedOrders
    SELECT o.OrderID
      FROM Sales.Orders AS o
     WHERE NOT EXISTS (SELECT 1 FROM Sales.Invoices AS i WHERE i.OrderID = o.OrderID);

    DECLARE @StockAlreadyAllocated TABLE
    (
        StockItemID int PRIMARY KEY,
        QuantityAllocated int
    );

    WITH StockAlreadyAllocated
    AS
    (
        SELECT ol.StockItemID, SUM(ol.PickedQuantity) AS TotalPickedQuantity
          FROM Sales.OrderLines AS ol
         INNER JOIN @UninvoicedOrders AS uo
            ON ol.OrderID = uo.OrderID
         WHERE ol.PickingCompletedWhen IS NULL
         GROUP BY ol.StockItemID
    )
    INSERT @StockAlreadyAllocated (StockItemID, QuantityAllocated)
    SELECT sa.StockItemID, sa.TotalPickedQuantity
      FROM StockAlreadyAllocated AS sa;

    DECLARE OrderLineList CURSOR FAST_FORWARD READ_ONLY
    FOR
    SELECT ol.OrderID, ol.OrderLineID, ol.StockItemID, ol.Quantity
      FROM Sales.OrderLines AS ol
     WHERE ol.PickingCompletedWhen IS NULL
     ORDER BY ol.OrderID, ol.OrderLineID;

    DECLARE @OrderID int;
    DECLARE @OrderLineID int;
    DECLARE @StockItemID int;
    DECLARE @Quantity int;
    DECLARE @AvailableStock int;
    -- DECLARE @PickingPersonID int = (SELECT TOP(1) PersonID
    --                                 FROM [Application].People
    --                                 WHERE IsEmployee <> 0
    --                                 ORDER BY NEWID());
    DECLARE @PickingPersonID INT
    EXEC [DataLoadSimulation].[GetRandomEmployeePerson]
      @EmployeePersonID = @PickingPersonID OUTPUT

    OPEN OrderLineList;
    FETCH NEXT FROM OrderLineList INTO @OrderID, @OrderLineID, @StockItemID, @Quantity;

    WHILE @@FETCH_STATUS = 0
    BEGIN
        -- work out available stock for this stock item (on hand less allocated)
        SET @AvailableStock = (SELECT QuantityOnHand FROM Warehouse.StockItemHoldings AS sih WHERE sih.StockItemID = @StockItemID);
        SET @AvailableStock -= COALESCE((SELECT QuantityAllocated FROM @StockAlreadyAllocated AS saa WHERE saa.StockItemID = @StockItemID), 0);

        IF @AvailableStock >= @Quantity
        BEGIN
            BEGIN TRAN;

            MERGE @StockAlreadyAllocated AS saa
            USING (VALUES (@StockItemID, @Quantity)) AS sa(StockItemID, Quantity)
            ON saa.StockItemID = sa.StockItemID
            WHEN MATCHED THEN
                UPDATE SET saa.QuantityAllocated += sa.Quantity
            WHEN NOT MATCHED THEN
                INSERT (StockItemID, QuantityAllocated) VALUES (sa.StockItemID, sa.Quantity);

            -- reserve the required stock
            UPDATE Sales.OrderLines
            SET PickedQuantity = @Quantity,
                PickingCompletedWhen = @StartingWhen,
                LastEditedBy = @PickingPersonID,
                LastEditedWhen = @StartingWhen
            WHERE OrderLineID = @OrderLineID;

            -- mark the order as ready to invoice (picking complete) if all lines picked
            IF NOT EXISTS (SELECT 1 FROM Sales.OrderLines AS ol
                                    WHERE ol.OrderID = @OrderID
                                    AND ol.PickingCompletedWhen IS NULL)
            BEGIN
                UPDATE Sales.Orders
                SET PickingCompletedWhen = @StartingWhen,
                    PickedByPersonID = @PickingPersonID,
                    LastEditedBy = @PickingPersonID,
                    LastEditedWhen = @StartingWhen
                WHERE OrderID = @OrderID;
            END;

            COMMIT;
        END;

        FETCH NEXT FROM OrderLineList INTO @OrderID, @OrderLineID, @StockItemID, @Quantity;
    END;

    CLOSE OrderLineList;
    DEALLOCATE OrderLineList;

END;