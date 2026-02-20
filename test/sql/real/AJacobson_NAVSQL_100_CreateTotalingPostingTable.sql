CREATE TABLE [dbo].[TotalingPosting](
	[Company] [NVARCHAR](20) NOT NULL,
	[TotalNo] [NVARCHAR](20) NOT NULL,
	[TotalName] [NVARCHAR](50) NOT NULL,
	[No_] [NVARCHAR](20) NOT NULL,
	[Name] [NVARCHAR](50) NOT NULL,
 CONSTRAINT [PK_TotalingPosting] PRIMARY KEY CLUSTERED 
(
	[Company] ASC,
	[TotalNo] ASC,
	[No_] ASC
)
)
