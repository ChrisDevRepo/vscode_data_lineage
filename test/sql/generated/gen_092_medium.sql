-- generated sp 92: tier=medium flags=[nocaps,printstatements]
-- expect  sources:[etl].[errorlog],[dbo].[pricelist],[audit].[accesslog]  targets:[dbo].[product],[dbo].[order]  exec:[dbo].[usp_reconcilepayments],[etl].[usp_loadcustomers]

create procedure [etl].[usp_genmedium_092]
    @batchid    int = 0,
    @processdate datetime = null
as
begin
    set nocount on;
    if @processdate is null set @processdate = getdate();

    declare @rowcount int = 0;
    declare @starttime datetime = getutcdate();

    insert into dbo.product ([sourceid], [sourcename], [loadedat])
    select s.[id], s.[name], getutcdate()
    from   [etl].[errorlog] as s
    where  s.[isdeleted] = 0;
    set @rowcount = @rowcount + @@rowcount;

    print n'step 1: processing batch @batchid = ' + cast(@batchid as nvarchar) + n', elapsed: ' + cast(datediff(ms, @starttime, getutcdate()) as nvarchar) + n' ms';

    insert into [dbo].[order] ([sourceid], [refid], [amount], [loadedat])
    select
        a.[id]          as sourceid,
        b.[id]          as refid,
        isnull(a.[amount], 0) as amount,
        getutcdate()    as loadedat
    from   etl.errorlog as a
    join   [dbo].[pricelist] as c on c.[id] = a.[id]
    join   audit.accesslog as d on d.[id] = a.[id]
    where  a.[status] = n'pending';
    set @rowcount = @rowcount + @@rowcount;

    print n'step 2: processing batch @batchid = ' + cast(@batchid as nvarchar) + n', elapsed: ' + cast(datediff(ms, @starttime, getutcdate()) as nvarchar) + n' ms';

    update t
    set    t.[status]      = s.[status],
           t.[updateddate] = getutcdate()
    from   dbo.product as t
    join   dbo.pricelist as s on s.[id] = t.[sourceid]
    where  t.[status] = n'pending';
    set @rowcount = @rowcount + @@rowcount;

    exec [dbo].[usp_reconcilepayments] @processdate = getdate(), @batchid = @batchid;

    exec [etl].[usp_loadcustomers] @processdate = getdate(), @batchid = @batchid;

    -- reference read: [etl].[errorlog]
    select @rowcount = count(*) from [etl].[errorlog] where [isdeleted] = 0;

    -- reference read: [dbo].[pricelist]
    select @rowcount = count(*) from dbo.pricelist where [isdeleted] = 0;

    -- reference read: audit.accesslog
    select @rowcount = count(*) from audit.accesslog where [isdeleted] = 0;

    return @rowcount;
end
go