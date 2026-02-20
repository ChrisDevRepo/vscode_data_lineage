CREATE PROCEDURE [dbo].[pGetNAVValues]
(@Company VARCHAR(128) = 'USA',
 @SelectionType VARCHAR(20) = 'Account',  -- Other options Fund or any valid Dimension
 @NAVString VARCHAR(255) = '',
 @UniqueIdentifier UNIQUEIDENTIFIER = NULL,
 @OutputType CHAR(10) = 'List' -- Option is List

 )
AS
BEGIN


DECLARE @SQLOutput NVARCHAR(MAX),
		@IndexOr INTEGER,
        @IndexAnd INTEGER,
        @StartSearch INTEGER,
        @FinalLoop TINYINT,
        @EndSearch INTEGER,
        @SubstringLen INTEGER,
        @TableSource VARCHAR(128),
        @DimensionCode VARCHAR(20),
		@Debug TINYINT = 0

IF @UniqueIdentifier IS NULL
  BEGIN
    SET @UniqueIdentifier = NEWID()
   END
SET @NAVString = UPPER(LTRIM(RTRIM(@NAVString)))

SET @NAVString = 
   CASE WHEN @NAVString = '*' THEN '0..ZZZZZZZZZZ'
   ELSE @NAVString
   END

SET @TableSource = 
     CASE @SelectionType 
	   WHEN 'Account' THEN 'vNAV_G_L Account'
	   WHEN 'Fund'    THEN 'vNAV_Fund'
	   ELSE 'vNAV_Dimension Value' 
	   END

SET @DimensionCode = 
     CASE WHEN @SelectionType IN ('Account','Fund')
	    THEN ''
     ELSE @SelectionType
	 END 


	        
DROP TABLE IF EXISTS #Values 

CREATE TABLE #Values 
(SelectionType VARCHAR(128) NOT NULL,
 DimensionCode VARCHAR(20) NOT NULL,
 FieldValue CHAR(20) NOT NULL,
 FieldName CHAR(100) NULL,
 CONSTRAINT PK_#Values PRIMARY KEY CLUSTERED (SelectionType, DimensionCode, FieldValue)
 ) 



DECLARE @AdditionalSQL CHAR(50) = 
CASE WHEN @TableSource = 'vNAV_G_L Account' THEN ' AND src.[Account Type] = 0 '
     WHEN @DimensionCode <> '' THEN ' AND src.[Dimension Code] = ''' + @DimensionCode + ''''
	 ELSE ''
	 end
DECLARE @FieldName CHAR(50) =
CASE WHEN @DimensionCode <> ''
 THEN 'Code' ELSE 'No_'
 end


BEGIN
-- For each NAVString accounting, we'll query to get teh accounts and save them into our temporary
-- table



SET @SQLOutput = 'INSERT INTO #Values SELECT ''' + @SelectionType + ''' , ''' + @DimensionCode +
             ''', src.' + RTRIM(@FieldName) + ', src.Name from dbo.' + QUOTENAME(@TableSource) + '
 src WHERE src.Company = ''' + @Company + '''' +RTRIM(@AdditionalSQL) + ' AND (' ;

IF ((CHARINDEX('|',@NAVString) <> 0)  OR (CHARINDEX('..',@NAVString) <> 0))

BEGIN

SET @IndexOr = CHARINDEX('|',@NAVString);
SET @StartSearch = 1;
SET @FinalLoop = 0;
WHILE @FinalLoop = 0
   BEGIN
	  SET @EndSearch = @IndexOr	-1 ;
	  IF @IndexOr = 0 -- if the last time round
	     BEGIN
		 SET @FinalLoop = 1;
		 SET @EndSearch = LEN(@NAVString);
		 END
      SET @SubstringLen = @EndSearch - @StartSearch  + 1
	  -- We have an @IndexOr value - the first or string
	  -- now we need to see if we need a between clause
     SET @IndexAnd = CHARINDEX('..',@NAVString,@StartSearch)
	 IF @IndexAnd <> 0 AND @IndexAnd < @EndSearch
	    BEGIN
		   SET @SQLOutput = @SQLOutput + 'src.' + RTRIM(@FieldName) + ' BETWEEN ''' + 
		   REPLACE(SUBSTRING(@NAVString,@StartSearch,@SubstringLen),'..',''' AND ''') + ''''
        END 
		ELSE
		BEGIN
		   SET @SQLOutput = @SQLOutput + ' src.' + RTRIM(@FieldName) + ' = ''' + SUBSTRING(@NAVString,@StartSearch,@SubstringLen)
		    + ''''
        END
		SET @StartSearch = @IndexOr + 1
		SET @IndexOr = CHARINDEX('|',@NAVString,@StartSearch)
		IF @FinalLoop <> 1
			BEGIN 
			  SET @SQLOutput = @SQLOutput + ' OR '
			END
	END	
SET @SQLOutput = @SQLOutput + ')';

END
ELSE
IF (CHARINDEX('*',@NAVString) <> 0)
BEGIN
DECLARE @WildcardString VARCHAR(255)
SET @WildcardString = 'src.' + RTRIM(@FieldName) + ' Like ''' + REPLACE(@NAVString,'*','%')  + ''')'
SET @SQLOutput = @SQLOutput + @WildcardString
END
ELSE 
IF (CHARINDEX('<>',@NavString)) <> 0
BEGIN
DECLARE @NotEqualString VARCHAR(255)
SET @NotEqualString = 'src.' + RTRIM(@FieldName) + ' Not In (''' + REPLACE(@NAVString,'<>','')
SET @NotEqualString = REPLACE(@NotEqualString,'&',''',''' ) + '''))'
SET @SQLOutput =  @SQLOutput + @NotEqualString
END
ELSE
BEGIN
DECLARE @OneValueString VARCHAR(255)
SET @OneValueString = 'src.' + RTRIM(@FieldName) + ' =  ''' + @NAVString + ''')'
SET @SQLOutput = @SQLOutput + @OneValueString
END


IF (@Debug = 1)
  BEGIN
     PRINT @SQLOutput
  END
BEGIN TRY 
BEGIN TRANSACTION ExecSQL
EXECUTE sp_executesql @SQLOutput;	
-- We need to have a blank record for old transactions
IF @NAVString = '0..ZZZZZZZZZZ'
INSERT INTO #Values
    (
        SelectionType,
        DimensionCode,
        FieldValue,
        FieldName
    )
VALUES
    (
        @SelectionType, -- SelectionType - varchar(128)
        @DimensionCode, -- DimensionCode - varchar(20)
        '', -- FieldValue - char(20)
        ''  -- FieldName - char(100)
    )

COMMIT TRANSACTION ExecSQL
END TRY
BEGIN CATCH
--SET @ErrorMessage = ERROR_MESSAGE()
--SET @ErrorSeverity = ERROR_SEVERITY()
--SET @ErrorState = ERROR_STATE()
--SET @StepStatus = 'Failure'

IF XACT_STATE() <> 0
 BEGIN 
    ROLLBACK TRANSACTION UpdatePeriod	
 END
 RETURN
END CATCH

IF @OutputType = 'List'
BEGIN
SELECT --@UniqueIdentifier, 
       val.SelectionType,
       val.FieldValue,
       val.FieldName	 FROM #Values val
	   ORDER BY val.SelectionType, val.DimensionCode, val.FieldValue
END
ELSE
BEGIN
INSERT INTO dbo.NAVReportValues
    (
        ID,
        SelectionType,
        FieldValue,
        FieldName
    )
SELECT @UniqueIdentifier,
       val.SelectionType,
       val.FieldValue,
       val.FieldName FROM #Values val
END
END
--DROP TABLE #Values
END 
GO


