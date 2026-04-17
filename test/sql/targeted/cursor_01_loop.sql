-- CURSOR Pattern 01: Anti-pattern cursor loop — all table refs inside cursor body must be captured
-- EXPECT  sources:[dbo].[Customer],[dbo].[Order],[dbo].[Product]  targets:[dbo].[CustomerReport],[dbo].[ReportLine]  exec:[dbo].[usp_LogReport]
-- Cursor-based row-by-row processing (anti-pattern, but common in legacy code)

DECLARE @CustomerID  INT;
DECLARE @CustomerName NVARCHAR(200);
DECLARE @ReportID    INT;

DECLARE customer_cursor CURSOR LOCAL FAST_FORWARD FOR
    SELECT [CustomerID], [FullName]
    FROM   [dbo].[Customer]
    WHERE  [IsActive] = 1
    ORDER  BY [CustomerID];

OPEN customer_cursor;
FETCH NEXT FROM customer_cursor INTO @CustomerID, @CustomerName;

WHILE @@FETCH_STATUS = 0
BEGIN
    -- Create report header per customer
    INSERT INTO [dbo].[CustomerReport] ([CustomerID],[CustomerName],[ReportDate],[Status])
    VALUES (@CustomerID, @CustomerName, GETDATE(), N'GENERATING');
    SET @ReportID = SCOPE_IDENTITY();

    -- Read orders for this customer and add detail lines
    INSERT INTO [dbo].[ReportLine] ([ReportID],[OrderID],[ProductName],[Qty],[Amount])
    SELECT
        @ReportID,
        o.[OrderID],
        p.[Name],
        o.[Quantity],
        o.[TotalAmount]
    FROM [dbo].[Order]   AS o
    JOIN [dbo].[Product] AS p ON p.[ProductID] = o.[ProductID]
    WHERE o.[CustomerID] = @CustomerID
      AND o.[Status]     = N'COMPLETE';

    -- Update status
    UPDATE [dbo].[CustomerReport]
    SET    [Status] = N'COMPLETE'
    WHERE  [ReportID] = @ReportID;

    FETCH NEXT FROM customer_cursor INTO @CustomerID, @CustomerName;
END;

CLOSE customer_cursor;
DEALLOCATE customer_cursor;

EXEC [dbo].[usp_LogReport] @Status = N'DONE', @CustomerCount = @@ROWCOUNT;
