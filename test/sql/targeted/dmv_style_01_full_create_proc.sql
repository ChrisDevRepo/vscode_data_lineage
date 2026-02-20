-- DMV Style Pattern 01: Full CREATE OR ALTER PROCEDURE body as returned by sys.sql_modules
-- EXPECT  sources:[sales].[vSalesPerson],[HumanResources].[Employee],[HumanResources].[Department]  targets:[dbo].[SalesPersonSummary]  exec:[dbo].[usp_LogRefresh]
-- Tests parser handling the full header (WITH EXECUTE AS, SET options, etc.)

CREATE OR ALTER PROCEDURE [dbo].[usp_RefreshSalesPersonSummary]
    @TerritoryID  INT          = NULL,
    @RefreshDate  DATE         = NULL,
    @ForceRefresh BIT          = 0
WITH EXECUTE AS OWNER,
     RECOMPILE
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    SET ANSI_NULLS ON;
    SET QUOTED_IDENTIFIER ON;

    DECLARE @Now     DATETIME2 = SYSUTCDATETIME();
    DECLARE @RowsAffected INT;

    IF @RefreshDate IS NULL
        SET @RefreshDate = CAST(@Now AS DATE);

    -- Refresh summary from view and HR data
    INSERT INTO [dbo].[SalesPersonSummary] (
        [SalesPersonID],
        [FullName],
        [JobTitle],
        [DepartmentName],
        [TerritoryName],
        [YTDSales],
        [YTDBonus],
        [CommissionPct],
        [HireDate],
        [RefreshedAt]
    )
    SELECT
        sp.[BusinessEntityID],
        sp.[FirstName] + N' ' + sp.[LastName],
        e.[JobTitle],
        d.[Name],
        sp.[TerritoryName],
        sp.[SalesYTD],
        sp.[BonusYTD],
        sp.[CommissionPct],
        e.[HireDate],
        @Now
    FROM      [sales].[vSalesPerson]         AS sp
    JOIN      [HumanResources].[Employee]    AS e  ON e.[BusinessEntityID] = sp.[BusinessEntityID]
    JOIN      [HumanResources].[Department]  AS d  ON d.[DepartmentID]     = e.[DepartmentID]
    WHERE (@TerritoryID IS NULL OR sp.[TerritoryID] = @TerritoryID);

    SET @RowsAffected = @@ROWCOUNT;

    EXEC [dbo].[usp_LogRefresh]
        @ProcName    = N'usp_RefreshSalesPersonSummary',
        @RowsAffected = @RowsAffected,
        @RefreshDate  = @RefreshDate;

END;
