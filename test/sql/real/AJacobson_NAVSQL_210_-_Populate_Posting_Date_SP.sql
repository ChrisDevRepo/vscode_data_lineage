CREATE PROCEDURE dbo.pPopulatePostingDates
(@StartingFiscalYear INTEGER = 2007,
 @ErrorMessage NVARCHAR(255) OUTPUT,
 @ErrorSeverity INT OUTPUT,
 @ErrorState INT OUTPUT,
 @ProcedureStep VARCHAR(30) OUTPUT)
AS
/* This procedure creates a date table beginning with the earliest date in the Accounting Period table until 35 days after the ending date in the Accounting Period Table.  It can be run nightly and will automatically update the PostingDates table with the latest information
  This table works off a view of the Accounting Period table and is designed to be run in a reporting database.  For more information on reporting databases and view, see my github repository here:
  You can also simply replace the line 
  dbo.[vNAV_Accounting Period]
  with a reference to the table in your system
*/

BEGIN
BEGIN TRY
BEGIN TRANSACTION UpdateRecords;
DECLARE @StartingDate DATETIME,
        @EndingDate DATETIME;
SELECT @StartingDate = MIN([Starting Date]),
	   @EndingDate = DATEADD(DAY,35,MAX([Starting Date]))
FROM dbo.[vNAV_Accounting Period] 
;
SET @ProcedureStep = '10-Intial Values';

WITH Dates (PostingDate) AS (
SELECT TOP 10000
DATEADD(DAY,ROW_NUMBER() OVER(ORDER BY col.object_id) -1,@StartingDate)
FROM sys.columns col
CROSS JOIN sys.tables tab
),
FiscalPeriods AS (
SELECT ap.[Starting Date], ap.Name AS PeriodName,
ROW_NUMBER() OVER(ORDER BY ap.[Starting Date]) AS PeriodID,
CAST(ROUND((ROW_NUMBER() OVER(ORDER BY ap.[Starting Date])-.1)/12,0,1) + @StartingFiscalYear AS INTEGER)
  AS FiscalYear
FROM dbo.[vNAV_Accounting Period] ap
WHERE ap.[Starting Date] <= @EndingDate
),
FiscalPeriodsMQ AS (
SELECT DISTINCT fp.[Starting Date], fp.FiscalYear, fp.PeriodID,
fp.PeriodID - 
((fp.FiscalYear - @StartingFiscalYear) * 12) AS FiscalPeriod,
fp.PeriodName
FROM FiscalPeriods fp
)

INSERT INTO dbo.PostingDates
(
    PostingDate,
    FiscalYear,
--    FiscalQuarter,
    FiscalPeriod,
--    FiscalWeek,
    MonthName,
--    QuarterID,
    PeriodID
--    WeekID
)
SELECT dte.PostingDate, pds.FiscalYear, 
pds.FiscalPeriod, 
--pds.FiscalYear * 100 + pds.FiscalPeriod AS FiscalYearPd,
pds.PeriodName,
pds.PeriodID FROM Dates dte
OUTER APPLY 
(SELECT TOP 1 fpm.PeriodID, fpm.FiscalYear, fpm.FiscalPeriod, fpm.PeriodName FROM FiscalPeriodsMQ fpm
 WHERE fpm.[Starting Date] <= dte.PostingDate
 ORDER BY fpm.[Starting Date] DESC) AS pds
 ORDER BY dte.PostingDate

 SET @ProcedureStep = '20 - Update Quarters'
 UPDATE dbo.PostingDates 
 SET FiscalQuarter = 
 CASE WHEN FiscalPeriod >=10 THEN 4
      WHEN FiscalPeriod >= 7 THEN 3
	  WHEN FiscalPeriod >= 4 THEN 2
	  ELSE 1 END
;
SET @ProcedureStep = '30 - Update Quarter ID';
WITH Quarters AS
(SELECT DISTINCT pd.FiscalYear, pd.FiscalQuarter FROM dbo.PostingDates pd),
quarterId AS
(SELECT qu.FiscalYear, qu.FiscalQuarter, ROW_NUMBER() OVER(ORDER BY qu.FiscalYear, qu.FiscalQuarter) AS QuarterID FROM Quarters qu
)
UPDATE pd 
SET pd.QuarterID = qid.QuarterID
FROM dbo.PostingDates pd
JOIN quarterId qid
ON qid.FiscalQuarter = pd.FiscalQuarter
AND qid.FiscalYear = pd.FiscalYear
SET @ProcedureStep = '40 - Update Weeks'
;
WITH wks AS (
SELECT 
pd.PostingDate,
ROUND
(
(
DATEDIFF(DAY,
MIN(PostingDate) OVER(PARTITION BY FiscalYear
ORDER BY PostingDate),PostingDate) + .9)/7,0,1)
+ 1 AS FiscalWeek
FROM dbo.PostingDates pd
)
UPDATE pd

SET pd.FiscalWeek = wk.FiscalWeek
from
dbo.PostingDates pd 
JOIN wks wk
ON wk.PostingDate = pd.PostingDate

SET @ProcedureStep = '50 - Update WeekID';
WITH Weeks AS
(SELECT DISTINCT pd.FiscalYear, pd.FiscalWeek FROM dbo.PostingDates pd)
,WeekId AS
(SELECT qu.FiscalYear, qu.FiscalWeek, ROW_NUMBER() OVER(ORDER BY qu.FiscalYear, qu.FiscalWeek) AS WeekID FROM Weeks qu
)
UPDATE pd 
SET pd.WeekID = wid.WeekID
FROM dbo.PostingDates pd
JOIN WeekId wid
ON wid.FiscalWeek = pd.FiscalWeek
AND wid.FiscalYear = pd.FiscalYear

COMMIT TRANSACTION UpdateRecords;
END TRY
BEGIN CATCH
  SET @ErrorMessage = ERROR_MESSAGE()
  SET @ErrorSeverity = ERROR_SEVERITY()
  SET @ErrorState = ERROR_STATE()
  IF XACT_STATE() <> 0
    BEGIN
	   ROLLBACK TRANSACTION UpdateRecords
    END
  RETURN
END CATCH
 SET @ProcedureStep = 'Complete' 
END 