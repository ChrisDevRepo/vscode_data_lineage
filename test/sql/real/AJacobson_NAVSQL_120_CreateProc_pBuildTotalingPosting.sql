-- This procedure populates the TotalingPosting table for a given structure.

CREATE PROCEDURE [dbo].[pBuildTotalingAccountsPostingAccounts]
(@Company VARCHAR(128) = 'USA',
 @Structure VARCHAR(3) = 'ALL' )
AS
DECLARE @Totaling NVARCHAR(250)
DECLARE @TotalName NVARCHAR(50)
DECLARE @TotalNo NVARCHAR(20)

DECLARE @SQLOutput NVARCHAR(MAX)
DECLARE @IndexOr INTEGER
DECLARE @IndexAnd INTEGER
DECLARE @StartSearch INTEGER
DECLARE @FinalLoop TINYINT
DECLARE @EndSearch INTEGER
DECLARE @SubstringLen INTEGER

delete From dbo.TotalingPosting
WHERE SUBSTRING(TotalNo,1,3) LIKE @Structure
OR @Structure = 'ALL';
 
/* we are goign to select all totaling accounts in order*/
DECLARE TotalAccounts CURSOR FAST_FORWARD READ_ONLY
FOR 
SELECT gla.No_, REPLACE(gla.Name,'''',''), gla.Totaling
 FROM dbo.[vNAV_G_L Account] gla
WHERE gla.[Account Type] = 2
AND gla.Totaling <> ''
AND gla.Company = @Company
and (SUBSTRING(gla.No_,1,3) = @Structure OR @Structure = 'ALL')
ORDER BY gla.No_ 
;
OPEN TotalAccounts;

FETCH NEXT FROM TotalAccounts INTO 
  @TotalNo, @TotalName, @Totaling
  ;
WHILE @@FETCH_STATUS = 0
BEGIN
-- For each totaling accounting, we'll query to get teh accounts and save them into our temporary
-- table
SET @SQLOutput = 'INSERT INTO TotalingPosting SELECT ''' +
   @Company + ''',''' + @TotalNo +''','''+@TotalName +
   ''', gla.No_, gla.Name from '+
  'dbo.[vNAV_G_L Account] gla WHERE gla.Company = ''' + 
    @Company + ''' AND gla.[Account Type] = 0 AND (' ;

SET @IndexOr = CHARINDEX('|',@Totaling);
SET @StartSearch = 1;
SET @FinalLoop = 0;
WHILE @FinalLoop = 0
   BEGIN
	  SET @EndSearch = @IndexOr	-1 ;
	  IF @IndexOr = 0 -- if the last time round
	     BEGIN
		 SET @FinalLoop = 1;
		 SET @EndSearch = LEN(@Totaling);
		 END
      SET @SubstringLen = @EndSearch - @StartSearch  + 1
	  -- We have an @IndexOr value - the first or string
	  -- now we need to see if we need a between clause
     SET @IndexAnd = CHARINDEX('..',@Totaling,@StartSearch)
	 IF @IndexAnd <> 0 AND @IndexAnd < @EndSearch
	    BEGIN
		   SET @SQLOutput = @SQLOutput + 'gla.No_ BETWEEN ''' + 
		   REPLACE(SUBSTRING(@Totaling,@StartSearch,@SubstringLen),'..',''' AND ''') + ''''
        END 
		ELSE
		BEGIN
		   SET @SQLOutput = @SQLOutput + ' gla.No_ = ''' + SUBSTRING(@Totaling,@StartSearch,@SubstringLen)
		    + ''''
        END
		SET @StartSearch = @IndexOr + 1
		SET @IndexOr = CHARINDEX('|',@Totaling,@StartSearch)
		IF @FinalLoop <> 1
			BEGIN 
			  SET @SQLOutput = @SQLOutput + ' OR '
			END
	END	
SET @SQLOutput = @SQLOutput + ')';
PRINT @SQLOutput;	
EXECUTE sp_executesql @SQLOutput;	
FETCH NEXT FROM TotalAccounts INTO @TotalNo, @TotalName, @Totaling;
IF @@FETCH_STATUS = 0 -- We have another record
  BEGIN
     SET @SQLOutput = @SQLOutput + ' UNION ALL '
  END
END;
CLOSE TotalAccounts
DEALLOCATE TotalAccounts





GO


