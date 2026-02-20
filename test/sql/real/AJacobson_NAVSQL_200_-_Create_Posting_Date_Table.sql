USE [NAVReportingTest]
GO

/****** Object:  Table [dbo].[PostingDates]    Script Date: 5/21/2020 4:32:23 AM ******/
SET ANSI_NULLS ON
GO

SET QUOTED_IDENTIFIER ON
GO

DROP TABLE IF EXISTS dbo.PostingDates
go

CREATE TABLE [dbo].[PostingDates](
	[PostingDate] [DATETIME] NOT NULL,
	[FiscalYear] [INT] NOT NULL,
	[FiscalQuarter] [INT] NULL,
	[FiscalPeriod] [INT] NOT NULL,
	[FiscalWeek] [INT] NULL,
	[MonthName] [VARCHAR](30) NULL,
	[QuarterID] [INT] NULL,
	[PeriodID] [INT] NULL,
	[WeekID] [INT] NULL,
 CONSTRAINT [PK_Fiscal] PRIMARY KEY CLUSTERED 
(
	[PostingDate] ASC
)
) ON [PRIMARY]
GO


