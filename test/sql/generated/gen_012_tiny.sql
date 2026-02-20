-- generated sp 12: tier=tiny flags=[nocaps]
-- expect  sources:[fin].[account],[rpt].[salessummary]  targets:[rpt].[employeeperf]  exec:

create procedure [fin].[usp_gentiny_012]
    @batchid    int = 0,
    @processdate datetime = null
as
begin
    set nocount on;
    if @processdate is null set @processdate = getdate();

    declare @rowcount int = 0;
    declare @starttime datetime = getutcdate();

    insert into rpt.employeeperf ([sourceid], [sourcename], [loadedat])
    select s.[id], s.[name], getutcdate()
    from   fin.account as s
    where  s.[isdeleted] = 0;
    set @rowcount = @rowcount + @@rowcount;

    -- reference read: [fin].[account]
    select @rowcount = count(*) from [fin].[account] where [isdeleted] = 0;

    -- reference read: [rpt].[salessummary]
    select @rowcount = count(*) from rpt.salessummary where [isdeleted] = 0;

    return @rowcount;
end
go