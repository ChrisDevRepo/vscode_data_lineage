-- CTE Pattern 02: Recursive CTE — base table captured; recursive self-reference does NOT produce false dep
-- EXPECT  sources:[dbo].[Employee],[dbo].[Department]  targets:[dbo].[OrgHierarchy]  exec:
-- CTE name OrgCTE must NOT appear in sources

WITH OrgCTE AS (
    -- Anchor member: top-level managers (no manager)
    SELECT
        e.[EmployeeID],
        e.[ManagerID],
        e.[FullName],
        e.[JobTitle],
        e.[DepartmentID],
        0 AS [Level],
        CAST(e.[FullName] AS NVARCHAR(4000)) AS [HierarchyPath]
    FROM [dbo].[Employee] AS e
    WHERE e.[ManagerID] IS NULL

    UNION ALL

    -- Recursive member: employees with a manager already in the CTE
    SELECT
        e.[EmployeeID],
        e.[ManagerID],
        e.[FullName],
        e.[JobTitle],
        e.[DepartmentID],
        cte.[Level] + 1,
        CAST(cte.[HierarchyPath] + N' > ' + e.[FullName] AS NVARCHAR(4000))
    FROM [dbo].[Employee] AS e
    JOIN OrgCTE AS cte ON cte.[EmployeeID] = e.[ManagerID]
)
INSERT INTO [dbo].[OrgHierarchy] ([EmployeeID],[ManagerID],[FullName],[JobTitle],[DepartmentID],[Level],[HierarchyPath],[DepartmentName],[RefreshedAt])
SELECT
    oc.[EmployeeID],
    oc.[ManagerID],
    oc.[FullName],
    oc.[JobTitle],
    oc.[DepartmentID],
    oc.[Level],
    oc.[HierarchyPath],
    d.[DepartmentName],
    GETUTCDATE()
FROM OrgCTE AS oc
JOIN [dbo].[Department] AS d ON d.[DepartmentID] = oc.[DepartmentID];
