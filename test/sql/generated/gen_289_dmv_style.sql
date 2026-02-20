-- generated sp 289: tier=dmv_style flags=[nobrackets,nocaps]
-- expect  sources:[dbo].[account],[dbo].[contact]  targets:[dbo].[pricelist],[stg].[customerstage]  exec:

set nocount on;

create or alter procedure [rpt].[usp_gendmv_style_289]
    @batchid    int = 0,
    @processdate datetime = null
with execute as owner
as
begin
    set nocount on;
    set xact_abort on;
    if @processdate is null set @processdate = getdate();

    declare @rowcount int = 0;
    declare @starttime datetime = getutcdate();

    insert into dbo.pricelist ([sourceid], [sourcename], [loadedat])
    select s.[id], s.[name], getutcdate()
    from   dbo.account as s
    where  s.[isdeleted] = 0;
    set @rowcount = @rowcount + @@rowcount;

    insert into stg.customerstage ([sourceid], [refid], [amount], [loadedat])
    select
        a.[id]          as sourceid,
        b.[id]          as refid,
        isnull(a.[amount], 0) as amount,
        getutcdate()    as loadedat
    from   dbo.account as a
    join   dbo.contact as c on c.[id] = a.[id]
    where  a.[status] = n'pending';
    set @rowcount = @rowcount + @@rowcount;

    update t
    set    t.[status]      = s.[status],
           t.[updateddate] = getutcdate()
    from   dbo.pricelist as t
    join   dbo.contact as s on s.[id] = t.[sourceid]
    where  t.[status] = n'pending';
    set @rowcount = @rowcount + @@rowcount;

    -- reference read: dbo.account
    select @rowcount = count(*) from dbo.account where [isdeleted] = 0;

    -- reference read: dbo.contact
    select @rowcount = count(*) from dbo.contact where [isdeleted] = 0;

    return @rowcount;
end
go