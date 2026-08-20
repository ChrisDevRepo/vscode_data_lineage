-- ANSI Old Pattern 03: SQL Server 2000 era — unqualified names (no schema prefix)
-- EXPECT  sources:  targets:  exec:
-- NOTE: All references here are UNQUALIFIED (no schema.table dot notation).
--       normalizeCaptured() rejects unqualified names (no dot → filtered out).
--       This is BY DESIGN — we cannot resolve "Orders" without knowing the schema.
--       EXPECT is intentionally EMPTY to verify zero false positives from old unqualified code.
--       absent:[dbo].[Orders],[dbo].[Customers],[dbo].[Products]

-- SQL Server 2000 / Northwind-era style (no schema prefix, uses dbo implicitly)
-- This is a STABILITY test: parser must not crash, must not produce false captures
CREATE PROCEDURE spGetOrdersByCustomer
    @CustomerID int
AS
BEGIN
    INSERT INTO SalesSummaryTemp
        (CustomerID, OrderCount, TotalAmount)
    SELECT
        CustomerID,
        COUNT(*),
        SUM(UnitPrice * Quantity)
    FROM Customers c, Orders o, OrderDetails od
    WHERE c.CustomerID = o.CustomerID
      AND o.OrderID    = od.OrderID
      AND c.CustomerID = @CustomerID

    SELECT * FROM SalesSummaryTemp
    DROP TABLE SalesSummaryTemp
END
GO
