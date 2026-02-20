-- Create this in the reporting database
CREATE      PROCEDURE [dbo].[pAllCompanyViews] AS
/* 
** Name: pAllCompanyViews
** File: pAllCompanyViews.SQL     
** Desc: Create single views for NAV Companies
** Prams: NA
** Return: NA
** Auth/Company: Adam Jacobson / Red Three
** Date: 
This procedure automatically builds views in the current database

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

DECLARE TableCur CURSOR FOR
  SELECT NavTableName FROM Tables 
OPEN TableCur
FETCH NEXT FROM TableCur INTO @Table
SET @SQL = N''
WHILE @@FETCH_STATUS = 0
	BEGIN
	SET @ViewName = 'vNAV_' + @Table
	IF EXISTS ( SELECT  1
                        FROM    sys.views
                        WHERE   name = @ViewName )
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


