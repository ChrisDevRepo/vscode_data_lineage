CREATE TABLE [dbo].[NAVReportValues](
	[ID] [UNIQUEIDENTIFIER] NOT NULL,
	[SelectionType] [VARCHAR](20) NOT NULL,
	[FieldValue] [CHAR](20) NOT NULL,
	[FieldName] [CHAR](100) NULL,
 CONSTRAINT [PK_#Values] PRIMARY KEY CLUSTERED 
(
	[ID] ASC,
	[SelectionType] ASC,
	[FieldValue] ASC
)
