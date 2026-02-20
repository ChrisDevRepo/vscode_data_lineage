-- generated sp 52: tier=medium flags=[nocaps,weirdwhitespace]
-- expect  sources:[etl].[extractlog],[rpt].[productrevenue],[dbo].[pricelist],[ops].[shipment]  targets:[dbo].[product],[stg].[orderstage]  exec:[etl].[usp_loadproducts]

	create procedure [rpt].[usp_genmedium_052]
    @batchid    int = 0,
    @processdate datetime = null
	as

begin
    set nocount on;
    if @processdate is null set @processdate = getdate();

    declare @rowcount int = 0;
    declare @starttime datetime = getutcdate();


    insert into [dbo].[product] ([sourceid], [sourcename], [loadedat])
    select s.[id], s.[name], getutcdate()
    from   [etl].[extractlog] as s
    where  s.[isdeleted] = 0;
    set @rowcount = @rowcount + @@rowcount;

	    insert into stg.orderstage ([sourceid], [refid], [amount], [loadedat])
	    select
        a.[id]          as sourceid,
        b.[id]          as refid,
        isnull(a.[amount], 0) as amount,
	        getutcdate()    as loadedat
    from   etl.extractlog as a
    join   [rpt].[productrevenue] as c on c.[id] = a.[id]
    join   [dbo].[pricelist] as d on d.[id] = a.[id]
    where  a.[status] = n'pending';
    set @rowcount = @rowcount + @@rowcount;
	
    update t
	    set    t.[status]      = s.[status],
           t.[updateddate] = getutcdate()
	    from   dbo.product as t
    join   [rpt].[productrevenue] as s on s.[id] = t.[sourceid]
    where  t.[status] = n'pending';
    set @rowcount = @rowcount + @@rowcount;

    exec etl.usp_loadproducts @processdate = getdate(), @batchid = @batchid;
	
	    -- reference read: [etl].[extractlog]
    select @rowcount = count(*) from [etl].[extractlog] where [isdeleted] = 0;


    -- reference read: [rpt].[productrevenue]

    select @rowcount = count(*) from rpt.productrevenue where [isdeleted] = 0;


    -- reference read: [dbo].[pricelist]
    select @rowcount = count(*) from dbo.pricelist where [isdeleted] = 0;

	    -- reference read: ops.shipment
    select @rowcount = count(*) from ops.shipment where [isdeleted] = 0;



    select	@rowcount   =  @rowcount + 0;  -- padding stmt
	
    return @rowcount;
	end
	go