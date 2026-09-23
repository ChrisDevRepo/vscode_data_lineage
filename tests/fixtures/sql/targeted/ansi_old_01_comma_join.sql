-- ANSI Old Pattern 01: Pre-SQL-92 comma-separated FROM clause (no JOIN keyword)
-- EXPECT  sources:[dbo].[Customer],[dbo].[Order],[dbo].[OrderLine],[dbo].[Product]  targets:[dbo].[SalesSummary]  exec:

-- Typical SQL Server 6.5 / 7.0 era stored procedure style
-- Written in 1998-style T-SQL, no JOIN keyword, all WHERE-clause predicates

CREATE PROCEDURE dbo.spBuildSalesSummary
AS
BEGIN
    INSERT INTO [dbo].[SalesSummary] (CustomerID, CustomerName, TotalOrders, TotalAmount, TopProduct)
    SELECT
        c.CustomerID,
        c.CompanyName,
        COUNT(DISTINCT o.OrderID),
        SUM(ol.UnitPrice * ol.Quantity),
        p.ProductName
    FROM
        dbo.Customer    c,
        dbo.[Order]     o,
        dbo.OrderLine   ol,
        dbo.Product     p
    WHERE
        c.CustomerID  = o.CustomerID
    AND o.OrderID     = ol.OrderID
    AND ol.ProductID  = p.ProductID
    AND o.OrderDate  >= '1998-01-01'
    AND o.Status      = 'CLOSED'
    AND c.Active      = 1
    GROUP BY
        c.CustomerID, c.CompanyName, p.ProductName
END
GO
