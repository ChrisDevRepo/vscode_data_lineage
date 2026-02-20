CREATE DATABASE [RF Database] 
GO

USE [RF Database]
GO

CREATE TABLE [dbo].[RF Pick Lines](
	[Entry No_] [int] IDENTITY(1,1) NOT NULL,
	[Pick Code] [varchar](20) NOT NULL,
	[Quantity] [decimal](38, 20) NOT NULL,
	[Terminal ID] [int] NOT NULL,
	[Display 1] [varchar](100) NOT NULL,
	[Display 2] [varchar](100) NOT NULL,
	[Display 3] [varchar](100) NOT NULL,
	[Display 4] [varchar](100) NOT NULL,
 CONSTRAINT [RF Pick Lines$0] PRIMARY KEY CLUSTERED 
(
	[Entry No_] ASC
)
)

GO

CREATE TABLE [dbo].[RF Finished Pick](
	[Reference Entry No] [int] NOT NULL,
	[Terminal ID] [int] NOT NULL,
	[Duration] [bigint] NOT NULL,
	[Ready Date Time] [datetime] NOT NULL,
 CONSTRAINT [RF Finished Pick$0] PRIMARY KEY CLUSTERED 
(
	[Reference Entry No] ASC
)
)

GO


INSERT INTO [RF Finished Pick] VALUES (1,1,60000,'2010-02-27 15:08')
INSERT INTO [RF Finished Pick] VALUES (2,1,60000,'2010-02-27 15:09')
INSERT INTO [RF Finished Pick] VALUES (3,1,60000,'2010-02-27 15:10')
GO

CREATE TABLE [dbo].[RF Exception](
	[Reference Entry No] [int] NOT NULL,
	[Terminal ID] [int] NOT NULL,
	[Duration] [bigint] NOT NULL,
	[Ready Date Time] [datetime] NOT NULL,
	[Description] [varchar](100) NOT NULL,
	[Qty_ Picked] [decimal](38, 20) NOT NULL,
 CONSTRAINT [RF Exception$0] PRIMARY KEY CLUSTERED 
(
	[Reference Entry No] ASC
)
)
GO
INSERT INTO [RF Exception] VALUES (4,1,60000,'2010-02-27 15:08','Inventory Broken',1)

USE [MASTER]

