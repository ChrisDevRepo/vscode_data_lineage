-- generated sp 21: tier=tiny flags=[nocaps]
-- expect  sources:[dbo].[salestarget],[dbo].[shipper]  targets:[hr].[leaverequest]  exec:[dbo].[usp_updatecustomer]

create procedure [ops].[usp_gentiny_021]
    @batchid    int = 0,
    @processdate datetime = null
as
begin
    set nocount on;
    if @processdate is null set @processdate = getdate();

    declare @rowcount int = 0;
    declare @starttime datetime = getutcdate();

    insert into hr.leaverequest ([sourceid], [sourcename], [loadedat])
    select s.[id], s.[name], getutcdate()
    from   [dbo].[salestarget] as s
    where  s.[isdeleted] = 0;
    set @rowcount = @rowcount + @@rowcount;

    exec dbo.usp_updatecustomer @processdate = getdate(), @batchid = @batchid;

    -- reference read: dbo.salestarget
    select @rowcount = count(*) from dbo.salestarget where [isdeleted] = 0;

    -- reference read: [dbo].[shipper]
    select @rowcount = count(*) from [dbo].[shipper] where [isdeleted] = 0;

    return @rowcount;
end
go