/** Preserves compiler-declared column expression references without inferring SQL roles. */
import JSZip from 'jszip';
import { expect, it } from 'vitest';
import { extractDacpac } from '../../../src/engine/dacpacExtractor';
import { loadParseRules } from '../helpers/testUtils';
loadParseRules();

async function extract(references: string) {
  const zip = new JSZip();
  zip.file('model.xml', `<DataSchemaModel><Model>
    <Element Type="SqlScalarFunction" Name="[demo].[Scalar]" />
    <Element Type="SqlInlineTableValuedFunction" Name="[demo].[Rows]" />
    <Element Type="SqlTable" Name="[demo].[Source]"><Relationship Name="Columns"><Entry>
      <Element Type="SqlSimpleColumn" Name="[demo].[Source].[Known]" />
    </Entry></Relationship></Element>
    <Element Type="SqlScalarFunction" Name="[server].[first].[demo].[Shared]" />
    <Element Type="SqlInlineTableValuedFunction" Name="[server].[second].[demo].[Shared]" />
    <Element Type="SqlView" Name="[demo].[Projected]">
      <Relationship Name="Columns"><Entry><Element Type="SqlComputedColumn" Name="[demo].[Projected].[Amount]">
        <Relationship Name="ExpressionDependencies"><Entry>${references}</Entry></Relationship>
      </Element></Entry></Relationship>
      <Relationship Name="BodyDependencies"><Entry><References Name="[demo].[Unrelated]" /></Entry></Relationship>
    </Element>
  </Model></DataSchemaModel>`);
  const model = await extractDacpac(await zip.generateAsync({ type: 'uint8array' }));
  return model.nodes.find(n => n.name === 'Projected')!.columns![0];
}

it('retains exact scalar, table-valued, unknown and external declaration identities in source order', async () => {
  const column = await extract(`<References Name="[demo].[Scalar]" />
    <References Name="[demo].[Rows]" />
    <References Name="[demo].[Source].[Known]" />
    <References Name="[demo].[Source].[Input]" />
    <References Name="[demo].[Scalar]" ExternalSource="OtherDatabase" />`);
  expect(column).toMatchObject({ expressionDependencies: [
    { reference: '[demo].[Scalar]', sourceElementType: 'SqlScalarFunction' },
    { reference: '[demo].[Rows]', sourceElementType: 'SqlInlineTableValuedFunction' },
    { reference: '[demo].[Source].[Known]', sourceElementType: 'SqlSimpleColumn' },
    { reference: '[demo].[Source].[Input]' },
    { reference: '[demo].[Scalar]', externalSource: 'OtherDatabase' },
  ] });
  expect(JSON.stringify(column)).not.toContain('Unrelated');
});

it('resolves complete qualified identities without collapsing different databases', async () => {
  expect(await extract(`<References Name="[server].[first].[demo].[Shared]" />
    <References Name="[server].[second].[demo].[Shared]" />
    <References Name="[server].[unknown].[demo].[Shared]" />`)).toMatchObject({ expressionDependencies: [
    { reference: '[server].[first].[demo].[Shared]', sourceElementType: 'SqlScalarFunction' },
    { reference: '[server].[second].[demo].[Shared]', sourceElementType: 'SqlInlineTableValuedFunction' },
    { reference: '[server].[unknown].[demo].[Shared]' },
  ] });
});

it('keeps old payload shape when declarations are absent or malformed', async () => {
  expect(await extract('<References /><References Name="" /><References Name="   " />')).not.toHaveProperty('expressionDependencies');
  expect(await extract('')).not.toHaveProperty('expressionDependencies');
});
