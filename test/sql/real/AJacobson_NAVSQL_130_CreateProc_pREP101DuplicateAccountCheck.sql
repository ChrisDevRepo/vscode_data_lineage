CREATE OR ALTER      PROCEDURE [dbo].[pREP101DuplicateAccountCheck]
(
   @Company VARCHAR(128) = 'USA',
   @Structure CHAR(3) = 'BS1'
)
AS
BEGIN

DECLARE	@return_value int
-- Update Totaling Posting first
EXEC	@return_value = [dbo].[pBuildTotalingAccountsPostingAccounts]
		@Company = @Company,
		@Prefix = @Structure


DECLARE @StructureType CHAR(2)

SELECT @StructureType = StructureType
 FROM dbo.Structure WHERE Structure = @Structure;

WITH PostingAccounts
AS (SELECT gla.No_, gla.Name FROM dbo.[vNAV_G_L Account] gla
WHERE 
 gla.Company = @Company
 AND 
 gla.[Account Type] = 0
 AND
 (
 (@StructureType = 'PL' AND gla.No_ BETWEEN '40000' AND '99999')
 OR 
 (@StructureType = 'BS' AND gla.No_ BETWEEN '10000' AND '39999')
 )

 )
 ,
 TotPost AS
 (SELECT tp.No_, COUNT(*) AS cnt FROM dbo.TotalingPosting tp
 WHERE SUBSTRING(tp.TotalNo,1,3) = @Structure
 AND tp.Company = @Company
 GROUP BY tp.No_)
 SELECT @Structure AS Structure, pa.No_,
        CASE COALESCE(tot.cnt,0) 
		 WHEN 0 THEN 'Missing'
		 ELSE 'Duplicate'
		 END AS MissingDuplicate,

        pa.Name,
		COALESCE(tp2.TotalNo,'') AS TotalNo,
		COALESCE(glat.Name,'') AS totalName,
		COALESCE(glat.Totaling,'') AS Totalling,
		COALESCE(tot.cnt,0) AS totcnt
		 FROM PostingAccounts pa
		 LEFT OUTER JOIN TotPost tot
		 ON tot.No_ = pa.No_ COLLATE DATABASE_DEFAULT
		 LEFT OUTER JOIN dbo.TotalingPosting tp2
		 ON pa.No_ = tp2.No_ COLLATE DATABASE_DEFAULT
		 AND @Structure = SUBSTRING(tp2.TotalNo,1,3)
		 LEFT OUTER JOIN dbo.[vNAV_G_L Account] glat
		 ON tp2.TotalNo = glat.No_ COLLATE DATABASE_DEFAULT
		 AND @Company = glat.Company

		 WHERE COALESCE(tot.cnt,0) <> 1
		 ORDER BY pa.No_
END
GO
