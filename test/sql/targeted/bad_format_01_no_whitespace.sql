-- BAD FORMAT Pattern 01: No whitespace, all lowercase keywords, identifiers crammed together
-- EXPECT  sources:[dbo].[order],[dbo].[customer],[dbo].[product]  targets:[dbo].[ordersummary]  exec:[dbo].[usp_log]
-- Tests parser robustness to terrible formatting

declare @d date=cast(getdate()as date);declare @rid int;insert into[dbo].[OrderSummary]([OrderDate],[CustomerID],[CustomerName],[TotalOrders],[TotalAmount],[TopProduct],[RefreshedAt])select cast(o.[OrderDate]as date),c.[CustomerID],c.[FullName],count(o.[OrderID]),sum(o.[TotalAmount]),max(p.[Name]),getutcdate()from[dbo].[Order]as o join[dbo].[Customer]as c on c.[CustomerID]=o.[CustomerID]join[dbo].[Product]as p on p.[ProductID]=o.[ProductID]where cast(o.[OrderDate]as date)=@d group by cast(o.[OrderDate]as date),c.[CustomerID],c.[FullName];exec[dbo].[usp_Log]@msg=N'RefreshDone',@rows=@@rowcount;
