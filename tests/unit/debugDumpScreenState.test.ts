/**
 * Tests for the debug-dump screen-state sections that make the dump self-sufficient
 * for "why does node X show / gray its +/- trace buttons?" — without the live app.
 *
 * Part 1 is a deterministic formatter check (hand-built render-state + tiny model).
 * Part 2 reproduces the reported scenario on the real AdventureWorks model:
 * Production.uspGetWhereUsedProductID has two inbound neighbours (BillOfMaterials = the
 * trace origin, and Product = off-trace), so the inbound prune is correctly absent and
 * Product is an add candidate — the dump must say exactly that.
 *
 * Execute via the support runner (npm test); root-level, auto-discovered.
 */
import { assert, assertEq, printSummary, loadAdventureWorksModel } from './helpers/testUtils';
import {
  formatScreenStateSections,
  type RenderStateSnapshot,
  type ScreenStateExtras,
} from '../../src/bridge/debugDumpScreenState';
import type { DatabaseModel } from '../../src/engine/types';

function part1_deterministicFormatter() {
  console.log('\n── Screen-state formatter (deterministic) ──');

  // proc 'p' inbound: 'b' (origin, in-trace) + 'x' (off-trace). 'u' is the other downstream leaf.
  const model = {
    edges: [
      { source: 'b', target: 'p' },
      { source: 'b', target: 'u' },
      { source: 'x', target: 'p' },
    ],
  } as unknown as DatabaseModel;

  const renderState: RenderStateSnapshot = {
    highlightedNodeId: 'p',
    affordances: {
      nodeId: 'p',
      in: {
        add: ['x'],
        prune: [],
        addDisabledReason: 'All upstream neighbors are already shown',
        pruneDisabledReason: 'This is the trace source — it cannot be removed',
        neighborCount: 2,
        visibleNeighborCount: 1,
      },
      out: { add: [], prune: [], addDisabledReason: '', pruneDisabledReason: '', neighborCount: 0, visibleNeighborCount: 0 },
    },
    traceScope: {
      mode: 'applied',
      origin: 'b',
      baseNodeIds: ['b', 'u', 'p'],
      manualAddedNodeIds: [],
      manualPrunedNodeIds: [],
      tracedNodeIds: ['b', 'u', 'p'],
    },
  };
  const screenState: ScreenStateExtras = { analytics: null, bookmark: null, detailOpen: true };

  const out = formatScreenStateSections(renderState, screenState, model);

  assert(out.includes('SELECTION & AFFORDANCES'), 'has SELECTION & AFFORDANCES section');
  assert(out.includes('Highlighted node: p'), 'reports the highlighted node');
  assert(out.includes('+add [x]'), 'inbound add offers the off-trace neighbour x');
  assert(out.includes('prune grayed: This is the trace source'), 'inbound prune grayed with accurate origin reason');
  assert(out.includes('TRACE SCOPE'), 'has TRACE SCOPE section');
  assert(out.includes('Traced (3)'), 'trace scope reports 3 traced nodes');
  assert(out.includes('DETAIL PANEL'), 'has DETAIL PANEL section');
  assert(out.includes('x [off-trace]'), 'detail panel tags x as off-trace');
  assert(out.includes('b [in-trace]'), 'detail panel tags origin b as in-trace');
}

function part1_analyticsAndBookmark() {
  console.log('\n── Screen-state formatter (analytics + bookmark) ──');
  const renderState: RenderStateSnapshot = { highlightedNodeId: null, affordances: null, traceScope: null };
  const screenState: ScreenStateExtras = {
    analytics: { type: 'hubs', activeGroupId: 'g1', groups: [{ id: 'g1', label: 'Top hubs', nodeIds: ['a', 'b'] }] },
    bookmark: { id: 'bm1', name: 'Sales core', source: 'ai', allowlistNodeIds: ['a', 'b', 'c'] },
    detailOpen: false,
  };

  const out = formatScreenStateSections(renderState, screenState, null);
  assert(out.includes('Affordances:      (none'), 'no-selection affordance note shown');
  assert(out.includes('ANALYTICS'), 'has ANALYTICS section when analytics active');
  assert(out.includes('▶ Top hubs (2)'), 'active analytics group marked and counted');
  assert(out.includes('BOOKMARK (active advanced view)'), 'has BOOKMARK section');
  assert(out.includes('Sales core [ai] — allowlist 3 node(s)'), 'bookmark name/source/allowlist size shown');
}

async function part2_realModelReproduction() {
  console.log('\n── Real AdventureWorks reproduction ──');
  const model = await loadAdventureWorksModel();

  const proc = model.nodes.find(n => n.name.toLowerCase() === 'uspgetwhereusedproductid');
  assert(!!proc, 'found Production/dbo.uspGetWhereUsedProductID in the model');
  if (!proc) return;

  // directNeighborIds is the same accessor the GUI affordance computation uses.
  const ins = formatInbound(model, proc.id);
  assertEq(ins.length, 2, 'proc has exactly two inbound neighbours');
  // Match the Product table precisely — "production" (the schema) also contains "product".
  const bomId = ins.find(id => id.toLowerCase().endsWith('.[billofmaterials]'));
  const productId = ins.find(id => id.toLowerCase().endsWith('.[product]'));
  assert(!!productId, 'one inbound neighbour is Product (off-trace second source)');
  assert(!!bomId, 'one inbound neighbour is BillOfMaterials (the trace origin)');
  if (!bomId || !productId) return;

  // Reproduce the reported trace: origin = BillOfMaterials, scope excludes Product.
  const renderState: RenderStateSnapshot = {
    highlightedNodeId: proc.id,
    affordances: {
      nodeId: proc.id,
      in: {
        add: [productId],
        prune: [],
        addDisabledReason: 'All upstream neighbors are already shown',
        pruneDisabledReason: 'This is the trace source — it cannot be removed',
        neighborCount: 2,
        visibleNeighborCount: 1,
      },
      out: { add: [], prune: [], addDisabledReason: '', pruneDisabledReason: '', neighborCount: 0, visibleNeighborCount: 0 },
    },
    traceScope: {
      mode: 'applied', origin: bomId,
      baseNodeIds: [bomId, proc.id], manualAddedNodeIds: [], manualPrunedNodeIds: [], tracedNodeIds: [bomId, proc.id],
    },
  };

  const out = formatScreenStateSections(renderState, { analytics: null, bookmark: null, detailOpen: true }, model);
  assert(out.includes(`${productId} [off-trace]`), 'dump tags Product as off-trace on real data');
  assert(out.includes(`${bomId} [in-trace]`), 'dump tags BillOfMaterials as in-trace on real data');
  assert(out.includes('prune grayed: This is the trace source'), 'dump explains the absent prune button as the trace source');
}

// Local inbound accessor mirroring the engine guard, kept here to avoid importing the GUI module.
function formatInbound(model: DatabaseModel, nodeId: string): string[] {
  const ids = new Set<string>();
  for (const e of model.edges) if (e.target === nodeId) ids.add(e.source);
  return Array.from(ids);
}

async function main() {
  console.log('═══ Debug Dump Screen-State Tests ═══');
  part1_deterministicFormatter();
  part1_analyticsAndBookmark();
  await part2_realModelReproduction();
  printSummary('Debug Dump Screen-State');
}

await main();
