-- STRINGS Pattern 02: Long NVARCHAR(MAX) strings with embedded SQL patterns — must NOT trigger rules
-- EXPECT  sources:[dbo].[Template],[dbo].[TemplateParameter]  targets:[dbo].[RenderedDocument]  absent:[anything that only appears in string literals]

DECLARE @Template    NVARCHAR(MAX);
DECLARE @FinalDoc    NVARCHAR(MAX);
DECLARE @TemplateKey NVARCHAR(100) = N'MONTHLY_REPORT';

-- Load template content (contains SQL-like strings as document text, not as SQL)
SELECT @Template = t.[TemplateBody]
FROM   [dbo].[Template] AS t
WHERE  t.[TemplateKey] = @TemplateKey;

-- Apply substitutions — string manipulation, no SQL executed from strings
SET @FinalDoc = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
    @Template,
    N'{{DATE}}',    CONVERT(NVARCHAR, GETDATE(), 106)),
    N'{{USER}}',    SUSER_SNAME()),
    N'SELECT_PLACEHOLDER', N''),   -- template contained SELECT keyword literally
    N'INSERT_PLACEHOLDER', N''),
    N'FROM_CLAUSE',         N'');

-- Insert parameters (NVARCHAR columns contain SQL-like text but must not trigger)
DECLARE @ParamText NVARCHAR(MAX) = (
    SELECT STRING_AGG(
        tp.[ParamName] + N' = ' + tp.[ParamValue], N'; '
    )
    FROM [dbo].[TemplateParameter] AS tp
    WHERE tp.[TemplateKey] = @TemplateKey
);
-- @ParamText might contain: "FROM = dbo.SomeTable; INSERT INTO = staging.Dest"
-- but it's just a string value, never executed

INSERT INTO [dbo].[RenderedDocument] (
    [TemplateKey],
    [RenderedContent],
    [Parameters],
    [RenderedAt],
    [RenderedBy]
)
VALUES (
    @TemplateKey,
    @FinalDoc,
    @ParamText,
    GETUTCDATE(),
    SUSER_SNAME()
);
