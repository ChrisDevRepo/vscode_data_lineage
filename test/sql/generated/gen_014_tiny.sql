-- generated sp 14: tier=tiny flags=[nocaps]
-- expect  sources:[stg].[customerstage]  targets:[audit].[accesslog]  exec:[etl].[usp_loadcustomers]

create procedure [etl].[usp_gentiny_014]
    @batchid    int = 0,
    @processdate datetime = null
as
begin
    set nocount on;
    if @processdate is null set @processdate = getdate();

    declare @rowcount int = 0;
    declare @starttime datetime = getutcdate();

    insert into [audit].[accesslog] ([sourceid], [sourcename], [loadedat])
    select s.[id], s.[name], getutcdate()
    from   stg.customerstage as s
    where  s.[isdeleted] = 0;
    set @rowcount = @rowcount + @@rowcount;

    exec [etl].[usp_loadcustomers] @processdate = getdate(), @batchid = @batchid;

    -- reference read: stg.customerstage
    select @rowcount = count(*) from stg.customerstage where [isdeleted] = 0;

    return @rowcount;
end
go