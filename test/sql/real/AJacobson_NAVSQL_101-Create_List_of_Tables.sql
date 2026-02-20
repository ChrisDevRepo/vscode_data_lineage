/* First, note that all my work assumes that you will create a separate reporting database for each actual NAV database you use.
   I do this to ensure that my objects never get clobbered.  Further, this eliminates many audit issues as a reporting developer only 
   needs to be able to read the actual NAV Database and need have no other authority */
   
/* Step 1 - Create a list of all Tables you will be reporting over.
    While NAV has hundreds of tables, you will probably not need the vast majority for reporting.
    */
/* Changes
2020-02-09  Added Column to allow this program to create views for tables with only one copy per database (as opposed to one copy per company)
*/
IF OBJECT_ID('dbo.Tables') IS NOT NULL
  DROP TABLE dbo.Tables
GO

CREATE TABLE [dbo].[Tables](
	[NAVTableName] [NVARCHAR](128) NOT NULL,
	[PerCompany] CHAR(1) NULL DEFAULT 'Y'
PRIMARY KEY CLUSTERED 
(
	[NAVTableName] ASC
)
)
/* Here's a list to get your started:
  these are the Table which have one copy per company.
*/
INSERT INTO dbo.Tables
(
    NAVTableName
)
VALUES
( N'Accounting Period' ), 
( N'Bank Account Ledger Entry' ), 
( N'Change Log Entry' ), 
( N'Check Ledger Entry' ), 
( N'Config_ Package Data' ), 
( N'Config_ Package Error' ), 
( N'Config_ Package Field' ), 
( N'Cust_ Ledger Entry' ), 
( N'Customer' ), 
( N'Customer Posting Group' ), 
( N'Default Dimension' ), 
( N'Detailed Cust_ Ledg_ Entry' ), 
( N'Detailed Vendor Ledg_ Entry' ), 
( N'Dimension Set Entry' ), 
( N'Dimension Value' ), 
( N'G_L Account' ), 
( N'G_L Budget Entry' ), 
( N'G_L Budget Name' ), 
( N'G_L Entry' ), 
( N'Gen_ Journal Batch' ), 
( N'Gen_ Journal Line' ), 
( N'General Ledger Setup' ), 
( N'Item' ), 
( N'Item Category' ), 
( N'Item Journal Line' ), 
( N'Item Ledger Entry' ), 
( N'Location' ), 
( N'Posted Bank Rec_ Header' ), 
( N'Posted Bank Rec_ Line' ), 
( N'Purch_ Cr_ Memo Hdr_' ), 
( N'Purch_ Cr_ Memo Line' ), 
( N'Purch_ Inv_ Header' ), 
( N'Purch_ Inv_ Line' ), 
( N'Purchase Header' ), 
( N'Purchase Line' ), 
( N'Purchase Price' ), 
( N'Sales Cr_Memo Header' ), 
( N'Sales Cr_Memo Line' ), 
( N'Sales Header' ), 
( N'Sales Invoice Header' ), 
( N'Sales Invoice Line' ), 
( N'Sales Line' ), 
( N'Ship-to Address' ), 
( N'Value Entry' ), 
( N'Vendor' ), 
( N'Vendor Ledger Entry' )
GO
INSERT INTO dbo.Tables
(
    NAVTableName,
	PerCompany
)
VALUES
('Access Control','N'),
('Company','N'),
('Object','N'),
('Object Metadata','N'),
('Permission','N'),
('Permission Set','N'),
('User','N'),
('User Group','N'),
('User Group Access Control','N'),
('User Group Member','N'),
('User Group Permission Set','N'),
('User Metadata','N'),
('User Personalization','N')
go
