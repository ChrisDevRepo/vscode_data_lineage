/** Preserves function signatures stored on DACPAC implementation annotations. */
import JSZip from 'jszip';
import { expect, it } from 'vitest';
import { extractDacpac } from '../../../src/engine/dacpacExtractor';
import { loadParseRules } from '../helpers/testUtils';
loadParseRules();
const header = 'CREATE FUNCTION [demo].[f] (@Amount decimal(18,2)) RETURNS decimal(18,2) AS';
const body = 'BEGIN RETURN @Amount * 2; END;';
async function extract(topHeader = '', nestedHeader = header, annotationType = 'SysCommentsObjectAnnotation', scriptBody = body) {
  const zip = new JSZip();
  zip.file('model.xml', `<DataSchemaModel><Model><Element Type="SqlScalarFunction" Name="[demo].[f]">
    ${topHeader ? `<Annotation Type="SysCommentsObjectAnnotation"><Property Name="HeaderContents" Value="${topHeader}" /></Annotation>` : ''}
    <Relationship Name="FunctionBody"><Entry><Element Type="SqlScriptFunctionImplementation">
      <Property Name="BodyScript"><Value><![CDATA[${scriptBody}]]></Value></Property>
      ${nestedHeader ? `<Annotation Type="${annotationType}"><Property Name="HeaderContents" Value="${nestedHeader}" /></Annotation>` : ''}
    </Element></Entry></Relationship>
  </Element></Model></DataSchemaModel>`);
  return (await extractDacpac(await zip.generateAsync({ type: 'uint8array' }))).nodes[0].bodyScript;
}
it('serves the exact implementation header, including parameters and scalar return type', async () => {
  expect(await extract()).toBe(`${header}\n${body}`);
});
it('preserves top-level header precedence and headerless fallback', async () => {
  expect(await extract('CREATE FUNCTION [demo].[f] () RETURNS int AS')).toBe(`CREATE FUNCTION [demo].[f] () RETURNS int AS\n${body}`);
  expect(await extract('', '')).toBe(`CREATE FUNCTION [demo].[f]\nAS\n${body}`);
});

it('ignores unrelated annotations and never delivers a header without a SQL body', async () => {
  expect(await extract('', header, 'OtherAnnotation')).toBe(`CREATE FUNCTION [demo].[f]\nAS\n${body}`);
  expect(await extract('', header, 'SysCommentsObjectAnnotation', '')).toBeUndefined();
});
