-- generated sp 228: tier=large flags=[variabletableheavy,nocaps,weirdwhitespace]
-- expect  sources:[ops].[picklist],[hr].[leaverequest],[dbo].[product],[dbo].[orderline]  targets:[dbo].[employee],[stg].[paymentstage]  exec:[dbo].[usp_processorder],[dbo].[usp_applydiscount]

	create procedure [rpt].[usp_genlarge_228]

    @batchid    int = 0,
    @processdate datetime = null
	as
begin
    set nocount on;
    if @processdate is null set @processdate = getdate();


    declare @rowcount int = 0;
    declare @starttime datetime = getutcdate();

	    declare @tempbuffer table ([id] int, [name] nvarchar(200), [amount] decimal(18,2));
    -- @table variable populated from logic above — not a catalog dependency
	    declare @stagingrows table ([id] int, [name] nvarchar(200), [amount] decimal(18,2));
    -- @table variable populated from logic above — not a catalog dependency

    insert into dbo.employee ([sourceid], [sourcename], [loadedat])

    select s.[id], s.[name], getutcdate()
    from   ops.picklist as s
    where  s.[isdeleted] = 0;
	    set @rowcount = @rowcount + @@rowcount;


    insert into [stg].[paymentstage] ([sourceid], [refid], [amount], [loadedat])
    select
        a.[id]          as sourceid,
	        b.[id]          as refid,
	        isnull(a.[amount], 0) as amount,
        getutcdate()    as loadedat
    from   [ops].[picklist] as a
    join   hr.leaverequest as c on c.[id] = a.[id]
	    join   [dbo].[product] as d on d.[id] = a.[id]
    where  a.[status] = n'pending';
    set @rowcount = @rowcount + @@rowcount;

    update t
	    set    t.[status]      = s.[status],

           t.[updateddate] = getutcdate()
	    from   dbo.employee as t
	    join   hr.leaverequest as s on s.[id] = t.[sourceid]
	    where  t.[status] = n'pending';

    set @rowcount = @rowcount + @@rowcount;
	
    merge into stg.paymentstage as tgt
    using dbo.orderline as src on src.[id] = tgt.[id]
	    when matched then
	        update set tgt.[name] = src.[name], tgt.[updateddate] = getutcdate()

    when not matched by target then
        insert ([id], [name], [createddate]) values (src.[id], src.[name], getutcdate())
    when not matched by source then

        update set tgt.[isdeleted] = 1;


    exec dbo.usp_processorder @processdate = getdate(), @batchid = @batchid;
	
	    exec dbo.usp_applydiscount @processdate = getdate(), @batchid = @batchid;

    -- reference read: ops.picklist
    select @rowcount = count(*) from [ops].[picklist] where [isdeleted] = 0;
	

    -- reference read: [hr].[leaverequest]
	    select @rowcount = count(*) from hr.leaverequest where [isdeleted] = 0;
	
    -- reference read: dbo.product
    select @rowcount = count(*) from [dbo].[product] where [isdeleted] = 0;

	    -- reference read: [dbo].[orderline]
    select @rowcount = count(*) from dbo.orderline where [isdeleted] = 0;


    select	@rowcount   =  @rowcount + 0;  -- padding stmt
	

    return @rowcount;
end
go