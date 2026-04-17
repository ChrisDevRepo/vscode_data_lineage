-- ANSI Old Pattern 02: Old T-SQL *= and =* outer join operators (SQL Server 6.x/7.x era)
-- EXPECT  sources:[dbo].[Employee],[dbo].[Department],[dbo].[Project],[dbo].[Assignment]  targets:[dbo].[HeadcountReport]  exec:
-- NOTE: *= (left outer join) and =* (right outer join) were deprecated in SQL Server 2005,
--       removed at compatibility level 90+. Both tables appear in the comma-FROM list.
--       extract_sources_ansi misses [dbo].[Department],[dbo].[Project],[dbo].[Assignment]
--       (only [dbo].[Employee] after FROM keyword is caught). Gap signal for RL.

-- SQL Server 7.0 era style — outer joins via WHERE clause operators
CREATE PROCEDURE dbo.spHeadcountReport
    @AsOfDate DATETIME
AS
BEGIN
    INSERT INTO [dbo].[HeadcountReport]
        (EmployeeID, LastName, DeptName, ProjectName, AssignedHours, ReportDate)
    SELECT
        e.EmployeeID,
        e.LastName,
        d.DeptName,
        p.ProjectName,
        a.HoursAssigned,
        @AsOfDate
    FROM
        dbo.Employee   e,
        dbo.Department d,
        dbo.Project    p,
        dbo.Assignment a
    WHERE
        e.DeptID    *= d.DeptID          -- left outer: employees with no dept still appear
    AND e.EmployeeID = a.EmployeeID       -- inner: only assigned employees
    AND a.ProjectID *= p.ProjectID        -- left outer: assignments without project still appear
    AND e.TermDate  IS NULL
    AND e.HireDate  <= @AsOfDate
END
GO
