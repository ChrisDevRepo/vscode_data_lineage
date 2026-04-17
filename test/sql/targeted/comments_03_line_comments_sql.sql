-- COMMENTS Pattern 03: Line comments containing SQL with table references — must NOT be extracted
-- EXPECT  sources:[sales].[Invoice],[sales].[InvoiceLine],[dbo].[Customer]  targets:[reporting].[InvoiceReport]  absent:[sales].[OldInvoice],[dbo].[ArchiveCustomer]

DECLARE @StartDate DATE = '2023-01-01';
DECLARE @EndDate   DATE = '2023-12-31';

-- Old query (v1):
-- SELECT * FROM [sales].[OldInvoice] WHERE InvoiceDate BETWEEN @StartDate AND @EndDate

-- Attempted rewrite (abandoned):
-- INSERT INTO [reporting].[InvoiceReport]
-- SELECT i.*, c.Name FROM [dbo].[ArchiveCustomer] c JOIN [sales].[OldInvoice] i ON i.CustID = c.CustID

-- Current implementation:
INSERT INTO [reporting].[InvoiceReport] (
    [InvoiceID],
    [CustomerID],
    [CustomerName],
    [InvoiceDate],
    [DueDate],
    [Subtotal],
    [TaxAmount],
    [TotalAmount],
    [LineCount],
    [Status]
)
SELECT
    i.[InvoiceID],          -- was: [sales].[OldInvoice].[InvoiceID] (renamed)
    i.[CustomerID],
    c.[CustomerName],       -- previously from [dbo].[ArchiveCustomer] — now live
    i.[InvoiceDate],
    i.[DueDate],
    SUM(il.[LineAmount]),   -- replaces: SELECT Amount FROM [sales].[OldInvoice]
    SUM(il.[TaxAmount]),
    SUM(il.[LineAmount]) + SUM(il.[TaxAmount]),
    COUNT(il.[InvoiceLineID]),
    i.[Status]
FROM      [sales].[Invoice]     AS i
JOIN      [dbo].[Customer]      AS c  ON c.[CustomerID]  = i.[CustomerID]
JOIN      [sales].[InvoiceLine] AS il ON il.[InvoiceID]  = i.[InvoiceID]
WHERE i.[InvoiceDate] BETWEEN @StartDate AND @EndDate
GROUP BY i.[InvoiceID], i.[CustomerID], c.[CustomerName], i.[InvoiceDate], i.[DueDate], i.[Status];
