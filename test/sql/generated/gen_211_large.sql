-- generated sp 211: tier=large flags=[variabletableheavy,nestedsubqueries,nocaps]
-- expect  sources:[dbo].[employee],[stg].[invoicestage],[ops].[picklist]  targets:[stg].[paymentstage],[etl].[batchcontrol]  exec:[etl].[usp_loadorders],[hr].[usp_approveleave],[dbo].[usp_generateinvoice],[dbo].[usp_reconcilepayments]

create procedure [dbo].[usp_genlarge_211]
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

    insert into [stg].[paymentstage] ([id], [name])
    select x.[id], x.[name]
    from (
        select i.[id], i.[name], row_number() over (order by i.[updateddate] desc) as rn
        from (
            select [id], [name], [updateddate]
            from   [dbo].[employee]
            where  [isdeleted] = 0
        ) as i
    ) as x
    where x.rn = 1;
    set @rowcount = @rowcount + @@rowcount;

    insert into etl.batchcontrol ([sourceid], [refid], [amount], [loadedat])
    select
        a.[id]          as sourceid,
        b.[id]          as refid,
        isnull(a.[amount], 0) as amount,
        getutcdate()    as loadedat
    from   dbo.employee as a
    join   [stg].[invoicestage] as c on c.[id] = a.[id]
    join   ops.picklist as d on d.[id] = a.[id]
    where  a.[status] = n'pending';
    set @rowcount = @rowcount + @@rowcount;

    update t
    set    t.[status]      = s.[status],
           t.[updateddate] = getutcdate()
    from   [stg].[paymentstage] as t
    join   stg.invoicestage as s on s.[id] = t.[sourceid]
    where  t.[status] = n'pending';
    set @rowcount = @rowcount + @@rowcount;

    merge into etl.batchcontrol as tgt
    using [ops].[picklist] as src on src.[id] = tgt.[id]
    when matched then
        update set tgt.[name] = src.[name], tgt.[updateddate] = getutcdate()
    when not matched by target then
        insert ([id], [name], [createddate]) values (src.[id], src.[name], getutcdate())
    when not matched by source then
        update set tgt.[isdeleted] = 1;

    exec etl.usp_loadorders @processdate = getdate(), @batchid = @batchid;

    exec [hr].[usp_approveleave] @processdate = getdate(), @batchid = @batchid;

    exec [dbo].[usp_generateinvoice] @processdate = getdate(), @batchid = @batchid;

    exec [dbo].[usp_reconcilepayments] @processdate = getdate(), @batchid = @batchid;

    -- reference read: dbo.employee
    select @rowcount = count(*) from dbo.employee where [isdeleted] = 0;

    -- reference read: [stg].[invoicestage]
    select @rowcount = count(*) from [stg].[invoicestage] where [isdeleted] = 0;

    -- reference read: ops.picklist
    select @rowcount = count(*) from [ops].[picklist] where [isdeleted] = 0;

    return @rowcount;
end
go