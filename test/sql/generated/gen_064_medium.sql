-- generated sp 64: tier=medium flags=[nocaps,commentedoutsql]
-- expect  sources:[rpt].[monthlyorders],[dbo].[region],[dbo].[orderline]  targets:[dbo].[customer]  exec:[fin].[usp_postjournal],[audit].[usp_logaccess]

create procedure [hr].[usp_genmedium_064]
    @batchid    int = 0,
    @processdate datetime = null
as
begin
    set nocount on;
    if @processdate is null set @processdate = getdate();

    declare @rowcount int = 0;
    declare @starttime datetime = getutcdate();

    -- old code (removed 2019-06-15) — kept for reference:
    -- insert into dbo.deprecatedlog (entityid, action, logdate)
    -- select id, n'process', getdate() from dbo.oldlegacytable where status = 0
    -- update dbo.oldflag set active = 0 where processdate < '2019-01-01'
    -- exec dbo.usp_oldarchive @cutoff = '2019-01-01'

    insert into dbo.customer ([sourceid], [sourcename], [loadedat])
    select s.[id], s.[name], getutcdate()
    from   rpt.monthlyorders as s
    where  s.[isdeleted] = 0;
    set @rowcount = @rowcount + @@rowcount;

    update t
    set    t.[status]      = s.[status],
           t.[updateddate] = getutcdate()
    from   dbo.customer as t
    join   dbo.region as s on s.[id] = t.[sourceid]
    where  t.[status] = n'pending';
    set @rowcount = @rowcount + @@rowcount;

    exec [fin].[usp_postjournal] @processdate = getdate(), @batchid = @batchid;

    exec [audit].[usp_logaccess] @processdate = getdate(), @batchid = @batchid;

    -- reference read: [rpt].[monthlyorders]
    select @rowcount = count(*) from rpt.monthlyorders where [isdeleted] = 0;

    -- reference read: [dbo].[region]
    select @rowcount = count(*) from dbo.region where [isdeleted] = 0;

    -- reference read: [dbo].[orderline]
    select @rowcount = count(*) from dbo.orderline where [isdeleted] = 0;

    return @rowcount;
end
go