/* the structure table allows you to have multiple sets of totaling accounts.
   The structure will be the same as the first three digits on the Totaling Account.
   After the strucuture, I show sample structures which I use in my demo example.
   You should also check out the excel file in this folder which provides three
   sets of totaling accounts with three different structures).
   */
CREATE TABLE [dbo].[Structure](
	[StructureType] [CHAR](2) NOT NULL,
	[Structure] [CHAR](3) NOT NULL,
	[StructureName] [CHAR](50) NULL,
 CONSTRAINT [PK_Structure] PRIMARY KEY CLUSTERED 
(
	[StructureType] ASC,
	[Structure] ASC
)
)
/* The first column is used by the duplicate check program (also in this folder)
   It should be 'IS' (or PL) to check income statement accounts
   or 'BS' to check balance sheet accounts)
*/

INSERT INTO 
dbo.Structure
(
    StructureType,
    Structure,
    StructureName
)
VALUES
( 'IS', 'R01', 'Example1                                          ' ), 
( 'IS', 'R02', 'Example1                                          ' ), 
( 'IS', 'R03', 'Example1                                          ' )
