-- Create this in the reporting database
IF OBJECT_ID('dbo.pPerDatabaseView') IS NOT NULL
DROP PROCEDURE dbo.pPerDatabaseViews
GO 

CREATE      PROCEDURE [dbo].[pPerDatabaseViews] AS
/* 
** Name: pPerDatabaseViews
** Desc: Create Views in Reporting Database for tables which exist once per database, not once per company
** Prams: NA
** Return: NA
** Auth/Company: Adam Jacobson / Red Three
** Date: 
This procedure automatically builds views in the current database
2020-02-09 Modified for tables that are not per company (e.g. Users, Permissions)
*/
BEGIN
DECLARE @SQLCompanyPrefix NVARCHAR(128)
DECLARE @CompanyName nvarchar(128)
DECLARE @CompanyAbbr NVARCHAR(20)
DECLARE @Table NVARCHAR(128)
DECLARE @SQL NVARCHAR(2000)
DECLARE @TargetDatabase NVARCHAR(128)
DECLARE @ViewName NVARCHAR(128)
declare @RowNumber int
SET NOCOUNT ON

DECLARE TableCur CURSOR READ_ONLY FAST_FORWARD FOR
  SELECT NavTableName FROM dbo.Tables
  WHERE PerCompany = 'Y'
OPEN TableCur
FETCH NEXT FROM TableCur INTO @Table
SET @SQL = N''
WHILE @@FETCH_STATUS = 0
	BEGIN
	SET @ViewName = 'vNAV_' + @Table
	IF OBJECT_ID(@ViewName) IS NOT null
		BEGIN
			   SET @SQL = 'DROP VIEW dbo.['+ @ViewName +']'
			    BEGIN TRY
                    EXEC sp_executesql @SQL;
					--PRINT @SQL
                END TRY
                BEGIN CATCH
                    SELECT  @ViewName, 'DROP',
                            ERROR_NUMBER() AS ErrorNumber ,
                            ERROR_MESSAGE() AS ErrorMessage;
                    BREAK;
                END CATCH
			 END
	SET @SQL = N''
	DECLARE CompaniesCur CURSOR FOR
		SELECT cmp.NAVDatabaseName, cmp.SQLCompanyPrefix, cmp.Abbr FROM dbo.Companies cmp
		where cmp.ReportingDatabaseName = DB_NAME() 
      ORDER BY cmp.SQLCompanyPrefix
	OPEN CompaniesCur
	SET @SQL = 'CREATE VIEW dbo.['+@ViewName + '] AS '
	FETCH NEXT FROM CompaniesCur INTO @TargetDatabase, @SQlCompanyPrefix, @CompanyName
    SET @RowNumber = 1
	WHILE @@FETCH_STATUS = 0
		BEGIN
		PRINT @TargetDatabase +  @SQLCompanyPrefix
		IF @RowNumber = 1
			BEGIN
			SET @SQL = @SQL + 'SELECT ''' +  RTRIM(@CompanyName) +
	        ''' AS Company, * FROM ' +
			RTRIM(@TargetDatabase) + '.dbo.[' +
	        RTRIM(@SQLCompanyPrefix) + '$' + RTRIM(@Table) + ']'
			END
			ELSE
			BEGIN
			SET @SQL = @SQL + ' UNION ALL SELECT ''' +  RTRIM(@CompanyName) +
	        ''' AS Company, * FROM ' +
			RTRIM(@TargetDatabase) + '.dbo.[' +
	        RTRIM(@SQLCompanyPrefix) + '$' + RTRIM(@Table) + ']'
			END	
		SET @RowNumber = @RowNumber + 1
		FETCH NEXT FROM CompaniesCur INTO @TargetDatabase, @SQlCompanyPrefix, @CompanyName
		END
	CLOSE CompaniesCur
	DEALLOCATE CompaniesCur	
	BEGIN TRY
	PRINT @SQL
     EXEC sp_executesql @SQL;
	--PRINT @SQL
	SET @SQL = ''
    END TRY
    BEGIN CATCH
		SELECT  @ViewName, 'CREATE',
				ERROR_NUMBER() AS ErrorNumber ,
				ERROR_MESSAGE() AS ErrorMessage;
        BREAK;
    END CATCH;
	
	FETCH NEXT FROM TableCur INTO @Table
	END   
   
 
CLOSE TableCur
DEALLOCATE TableCur

END

GO


