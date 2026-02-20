-- generated sp 7: tier=tiny flags=[nocaps]
-- expect  sources:[dbo].[invoice]  targets:[dbo].[customer]  exec:[dbo].[usp_generateinvoice]

create procedure [ops].[usp_gentiny_007]
    @batchid    int = 0,
    @processdate datetime = null
as
begin
    set nocount on;
    if @processdate is null set @processdate = getdate();

    declare @rowcount int = 0;
    declare @starttime datetime = getutcdate();

    insert into [dbo].[customer] ([sourceid], [sourcename], [loadedat])
    select s.[id], s.[name], getutcdate()
    from   [dbo].[invoice] as s
    where  s.[isdeleted] = 0;
    set @rowcount = @rowcount + @@rowcount;

    exec [dbo].[usp_generateinvoice] @processdate = getdate(), @batchid = @batchid;

    -- reference read: [dbo].[invoice]
    select @rowcount = count(*) from [dbo].[invoice] where [isdeleted] = 0;

    return @rowcount;
end
go