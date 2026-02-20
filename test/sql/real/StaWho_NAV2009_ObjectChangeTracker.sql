/*
Tracking changes to objects in NAV can prove challenging at times, especially in multi-developer environments. Below method of tracking changes (in fact well known one) uses triggers on Object table in NAV database to insert records to custom SQL table, whenever there is an INSERT, MODIFY or UPDATE to said table. It's particularly handy for strictly controlled environments, where the data it holds after a go-live can be cross referenced with documentation. Note, that the below query disables newly created triggers by default.
*/

GO
SET QUOTED_IDENTIFIER OFF
GO
SET ANSI_NULLS ON
GO
  
create table [dbo].[Tracker]
(
    [Entry Date] datetime,
    [Entry Type] varchar(3),
    [User] varchar(100),
    [Database] varchar(50), 
    [Company Name] varchar(100),
    [Object Type] varchar(20),
    [Object ID] int,
    [Object Name] varchar(100),
    [Object Date] date, 
    [Object Time] time,
    [Object Size] int,
    [Locked By] varchar(100),
)
  
grant INSERT,UPDATE on [dbo].[Tracker] to public
go
  
--Trigger on INSERT
create TRIGGER [dbo].[trg_Object_Insert] ON [dbo].[Object] after insert
AS
SET NOCOUNT ON;
insert into [Tracker]
    ([Entry Date],[Entry Type],[User],[Database],[Company Name],[Object Type],[Object ID],[Object Name],[Object Date],[Object Time],[Object Size],[Locked By])
  
    select  getdate(),
            'INS',
            SYSTEM_USER, 
            DB_NAME(), 
            [Company Name],
            (case
                when [Type] = 1 then 'Table'
                when [Type] = 2 then 'Form'
                when [Type] = 3 then 'Report'
                when [Type] = 4 then 'Dataport'
                when [Type] = 5 then 'Codeunit'
                when [Type] = 6 then 'XMLPort'
                when [Type] = 7 then 'Menusuite'
                when [Type] = 8 then 'Page'
                else cast([Type] as varchar)
            end),
            [ID],
            [Name],
            [Date],
            [Time],
            [BLOB Size],
            [Locked By]
    from [Inserted]
    where [BLOB Size] > 0
GO
  
--Trigger on UPDATE
create TRIGGER [dbo].[trg_Object_Update] ON [dbo].[Object] after update
AS
SET NOCOUNT ON;
insert into [Tracker]
    ([Entry Date],[Entry Type],[User],[Database],[Company Name],[Object Type],[Object ID],[Object Name],[Object Date],[Object Time],[Object Size],[Locked By])
  
    select  getdate(),
            'UPD',
            SYSTEM_USER, 
            DB_NAME(), 
            [Company Name],
            (case
                when [Type] = 1 then 'Table'
                when [Type] = 2 then 'Form'
                when [Type] = 3 then 'Report'
                when [Type] = 4 then 'Dataport'
                when [Type] = 5 then 'Codeunit'
                when [Type] = 6 then 'XMLPort'
                when [Type] = 7 then 'Menusuite'
                when [Type] = 8 then 'Page'
                else cast([Type] as varchar)
            end),
            [ID],
            [Name],
            [Date],
            [Time],
            [BLOB Size],
            [Locked By]
    from [Inserted]
    where [BLOB Size] > 0
GO
  
--Trigger on DELETE
create TRIGGER [dbo].[trg_Object_Delete] ON [dbo].[Object] after delete
AS
SET NOCOUNT ON;
insert into [Tracker]
    ([Entry Date],[Entry Type],[User],[Database],[Company Name],[Object Type],[Object ID],[Object Name],[Object Date],[Object Time],[Object Size],[Locked By])
  
    select  getdate(),
            'DEL',
            SYSTEM_USER, 
            DB_NAME(), 
            [Company Name],
            (case
                when [Type] = 1 then 'Table'
                when [Type] = 2 then 'Form'
                when [Type] = 3 then 'Report'
                when [Type] = 4 then 'Dataport'
                when [Type] = 5 then 'Codeunit'
                when [Type] = 6 then 'XMLPort'
                when [Type] = 7 then 'Menusuite'
                when [Type] = 8 then 'Page'
                else cast([Type] as varchar)
            end),
            [ID],
            [Name],
            [Date],
            [Time],
            [BLOB Size],
            [Locked By]
    from [Deleted]
    where [BLOB Size] > 0
GO
  
disable trigger ALL on [dbo].[Object]