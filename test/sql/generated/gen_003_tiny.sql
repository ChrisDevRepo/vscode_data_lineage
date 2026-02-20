-- generated sp 3: tier=tiny flags=[nocaps]
-- expect  sources:[dbo].[invoice]  targets:[fin].[account]  exec:

create procedure [rpt].[usp_gentiny_003]
    @batchid    int = 0,
    @processdate datetime = null
as
begin
    set nocount on;
    if @processdate is null set @processdate = getdate();

    declare @rowcount int = 0;
    declare @starttime datetime = getutcdate();

    insert into fin.account ([sourceid], [sourcename], [loadedat])
    select s.[id], s.[name], getutcdate()
    from   dbo.invoice as s
    where  s.[isdeleted] = 0;
    set @rowcount = @rowcount + @@rowcount;

    -- reference read: dbo.invoice
    select @rowcount = count(*) from dbo.invoice where [isdeleted] = 0;

    return @rowcount;
end
go