-- COMMENTS Pattern 02: Deeply nested block comments — must NOT be extracted
-- EXPECT  sources:[dbo].[Employee],[hr].[Department],[hr].[JobGrade]  targets:[hr].[PayrollRun]  exec:[hr].[usp_ValidatePayroll]  absent:[dbo].[OldPayroll],[hr].[LegacyEmployee]

/*
  Outer comment start
  /* inner comment level 1
     SELECT * FROM [dbo].[OldPayroll]
     /* inner comment level 2
        INSERT INTO [hr].[LegacyEmployee] ...
        FROM [dbo].[OldPayroll] WHERE Active = 1
     */  -- end level 2
     More text: UPDATE [dbo].[OldPayroll] SET x = 1
  */ -- end level 1
  Still in outer comment: EXEC [dbo].[DeprecatedProc]
*/

DECLARE @PayPeriodStart DATE = DATEADD(MONTH, DATEDIFF(MONTH,0,GETDATE()), 0);
DECLARE @PayPeriodEnd   DATE = EOMONTH(GETDATE());
DECLARE @RunID          INT;

-- Insert payroll run header
INSERT INTO [hr].[PayrollRun] ([PeriodStart],[PeriodEnd],[Status],[CreatedAt])
VALUES (@PayPeriodStart, @PayPeriodEnd, N'PENDING', GETUTCDATE());

SET @RunID = SCOPE_IDENTITY();

-- Calculate payroll from live tables
INSERT INTO [hr].[PayrollRun] ([RunID],[EmployeeID],[DepartmentID],[GradeCode],[GrossPay],[NetPay],[Status])
SELECT
    @RunID,
    e.[EmployeeID],
    e.[DepartmentID],
    e.[GradeCode],
    jg.[BaseSalary] + ISNULL(e.[Bonus], 0),
    (jg.[BaseSalary] + ISNULL(e.[Bonus], 0)) * (1 - jg.[TaxRate]),
    N'CALCULATED'
FROM      [dbo].[Employee]   AS e
JOIN      [hr].[Department]  AS d  ON d.[DepartmentID] = e.[DepartmentID]
JOIN      [hr].[JobGrade]    AS jg ON jg.[GradeCode]   = e.[GradeCode]
WHERE e.[IsActive] = 1
  AND d.[IsActive] = 1;

EXEC [hr].[usp_ValidatePayroll] @RunID = @RunID;
