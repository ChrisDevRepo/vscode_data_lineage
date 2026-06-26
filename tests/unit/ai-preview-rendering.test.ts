import assert from 'node:assert/strict';
import { preprocessDescriptionMarkdown } from '../../src/components/aiDescriptionMarkdown';
import { buildTableTraceColumns, groupCtFlowsByNeighbor, type CtTooltipFlow } from '../../src/components/CustomNode';
import { deriveAiPreviewExpandedSchemas } from '../../src/engine/aiPreviewScope';
import type { DatabaseModel, ObjectType } from '../../src/engine/types';

function run() {
  const withInline = 'Fallback uses $0$ when no price exists.';
  const processedInline = preprocessDescriptionMarkdown(withInline);
  assert.equal(processedInline, withInline, 'inline content is preserved byte-for-byte (lossless normalization)');

  // remark-math + rehype-katex handle $$ natively in AiDescriptionOverlay — preprocessDescriptionMarkdown is a passthrough.
  const withBlock = 'Revenue formula:\n\n$$\\text{TotalRevenue}=\\text{Qty}\\times\\text{UnitPrice}$$';
  const processedBlock = preprocessDescriptionMarkdown(withBlock);
  assert.equal(processedBlock, withBlock, '$$ block math is preserved byte-for-byte (rendered by remark-math/rehype-katex, not pre-processed)');

  const flows: CtTooltipFlow[] = [
    { neighborNode: '[ai].[vwPriceList]', direction: 'in', fromCol: 'UnitPrice', toCol: 'TotalRevenue' },
    { neighborNode: '[ai].[vwConsolidatedSales]', direction: 'in', fromCol: 'Qty', toCol: 'TotalRevenue' },
    { neighborNode: '[ai].[vwPriceList]', direction: 'in', fromCol: 'UnitPrice', toCol: 'TotalRevenue' }, // duplicate
  ];
  const cols = buildTableTraceColumns(flows);
  assert.deepEqual(cols, ['Qty', 'TotalRevenue', 'UnitPrice'], 'table tooltip columns are unique and sorted without arrow semantics');

  const grouped = groupCtFlowsByNeighbor(flows);
  assert.equal(grouped.length, 2, 'flows are grouped by neighbor');
  assert.equal(grouped[0]?.neighborNode, '[ai].[vwConsolidatedSales]');
  assert.equal(grouped[1]?.neighborNode, '[ai].[vwPriceList]');
  assert.equal(grouped[1]?.rows.length, 1, 'duplicate flows are removed within a neighbor group');

  const model = {
    nodes: [
      { id: '[Sales].[Order]', schema: 'Sales', name: 'Order', fullName: '[Sales].[Order]', type: 'table' as ObjectType },
      { id: '[Sales].[OrderLine]', schema: 'Sales', name: 'OrderLine', fullName: '[Sales].[OrderLine]', type: 'table' as ObjectType },
      { id: '[Finance].[Invoice]', schema: 'Finance', name: 'Invoice', fullName: '[Finance].[Invoice]', type: 'view' as ObjectType },
      { id: '[dbo].[Ignored]', schema: 'dbo', name: 'Ignored', fullName: '[dbo].[Ignored]', type: 'table' as ObjectType },
    ],
    edges: [],
    schemas: [],
    catalog: {},
    neighborIndex: {},
  } satisfies DatabaseModel;
  assert.deepEqual(
    [...deriveAiPreviewExpandedSchemas(model, new Set(['[Sales].[Order]', '[Finance].[Invoice]']))].sort(),
    ['Finance', 'Sales'],
    'AI preview expands every schema represented by preview objects',
  );

  console.log('ai-preview-rendering tests passed');
}

run();
