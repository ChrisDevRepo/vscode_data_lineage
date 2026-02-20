-- INSERT EXEC Pattern 01: Basic INSERT INTO ... EXEC
-- EXPECT  targets:[dbo].[ReportData]  exec:[dbo].[usp_GetReportData]
-- Note: temp table should NOT be captured; @tbl variable should NOT be captured

DECLARE @StartDate DATE = DATEADD(MONTH, -1, GETDATE());
DECLARE @EndDate   DATE = GETDATE();

-- Populate staging via SP result
INSERT INTO [dbo].[ReportData] (
    [ReportDate],
    [Region],
    [ProductCategory],
    [TotalSales],
    [UnitsSold],
    [AvgUnitPrice]
)
EXEC [dbo].[usp_GetReportData]
    @StartDate = @StartDate,
    @EndDate   = @EndDate,
    @IncludeReturns = 0;
