import { type DatabaseModel, type TraceAffordanceSnapshot, type TraceAffordanceSideSnapshot } from '../engine/types';
import { directNeighborIds } from '../engine/graphGuards';
import { trunc } from '../utils/log';

/** Subset of the `render-state` payload the dump reads to explain trace/affordance questions. */
export interface RenderStateSnapshot {
  highlightedNodeId?: string | null;
  affordances?: TraceAffordanceSnapshot | null;
  traceScope?: {
    mode: string;
    origin: string | null;
    baseNodeIds: string[];
    manualAddedNodeIds: string[];
    manualPrunedNodeIds: string[];
    tracedNodeIds: string[];
  } | null;
}

/** Analytics/bookmark mode state carried on `uiState.screenState` (not in render-state). */
export interface ScreenStateExtras {
  analytics?: { type: string; activeGroupId: string | null; groups: { id: string; label: string; nodeIds: string[] }[] } | null;
  bookmark?: { id: string; name: string; source: string | null; allowlistNodeIds: string[] } | null;
  detailOpen?: boolean;
}

/** Truncates a node-id list for dump display, keeping it scannable. */
export function formatIdList(ids: readonly string[], cap = 40): string {
  if (ids.length === 0) return '(none)';
  return trunc([...ids], cap);
}

/** Formats one lineage side's add/prune affordances, surfacing the grayed-control reason. */
function formatAffordanceSide(label: string, side: TraceAffordanceSideSnapshot): string {
  const parts = [
    `  ${label}: +add [${side.add.join(', ') || '—'}]  −prune [${side.prune.join(', ') || '—'}]  (neighbors=${side.neighborCount}, in-trace=${side.visibleNeighborCount})`,
  ];
  if (side.add.length === 0 && side.neighborCount > 0) parts.push(`             add grayed: ${side.addDisabledReason}`);
  if (side.prune.length === 0 && side.visibleNeighborCount > 0) parts.push(`             prune grayed: ${side.pruneDisabledReason}`);
  return parts.join('\n');
}

/**
 * Builds the on-screen-state dump sections that explain "why does node X show/hide its
 * +/- buttons" without the live app: the highlighted node, its computed affordances and the
 * reason each control is grayed, the live trace scope, the selected node's full neighbors
 * tagged in-trace vs off-trace, and any active analytics/bookmark view.
 *
 * @param renderState - The latest `render-state` snapshot mirrored from the webview.
 * @param screenState - Analytics/bookmark extras from the latest `filter-changed` ui-state.
 * @param model - The loaded database model, for neighbor reconciliation.
 * @returns A formatted multi-section block (always includes SELECTION & AFFORDANCES).
 */
export function formatScreenStateSections(
  renderState: RenderStateSnapshot | null,
  screenState: ScreenStateExtras | null,
  model: DatabaseModel | null,
): string {
  const out: string[] = [];
  const hn = renderState?.highlightedNodeId ?? null;
  const traced = new Set(renderState?.traceScope?.tracedNodeIds ?? []);

  out.push('SELECTION & AFFORDANCES');
  out.push(`  Highlighted node: ${hn ?? '(none)'}`);
  const aff = renderState?.affordances ?? null;
  if (!aff) {
    out.push('  Affordances:      (none — add/prune controls render only on the highlighted node in an editable trace)');
  } else {
    out.push(formatAffordanceSide('Inbound ', aff.in));
    out.push(formatAffordanceSide('Outbound', aff.out));
  }
  out.push('');

  const ts = renderState?.traceScope ?? null;
  if (ts) {
    out.push('TRACE SCOPE');
    out.push(`  Mode: ${ts.mode}    Origin: ${ts.origin ?? '(none)'}`);
    out.push(`  Traced (${ts.tracedNodeIds.length}):          ${formatIdList(ts.tracedNodeIds)}`);
    out.push(`  Base (${ts.baseNodeIds.length}):            ${formatIdList(ts.baseNodeIds)}`);
    out.push(`  Manually added (${ts.manualAddedNodeIds.length}):  ${formatIdList(ts.manualAddedNodeIds)}`);
    out.push(`  Manually pruned (${ts.manualPrunedNodeIds.length}): ${formatIdList(ts.manualPrunedNodeIds)}`);
    out.push('');
  }

  if (hn && model) {
    const ins = directNeighborIds(model, hn, 'in');
    const outs = directNeighborIds(model, hn, 'out');
    const tag = (id: string) => `${id} ${traced.has(id) ? '[in-trace]' : '[off-trace]'}`;
    out.push('DETAIL PANEL (selected node — full neighbors vs. trace scope)');
    out.push(`  Node: ${hn}${screenState?.detailOpen ? '  (detail panel open)' : ''}`);
    out.push(`  IN  (${ins.length}): ${ins.length ? ins.map(tag).join(', ') : '(none)'}`);
    out.push(`  OUT (${outs.length}): ${outs.length ? outs.map(tag).join(', ') : '(none)'}`);
    out.push('');
  }

  const analytics = screenState?.analytics ?? null;
  if (analytics) {
    out.push('ANALYTICS');
    out.push(`  Type: ${analytics.type}    Active group: ${analytics.activeGroupId ?? '(all)'}`);
    for (const g of analytics.groups) {
      out.push(`    ${g.id === analytics.activeGroupId ? '▶ ' : '  '}${g.label} (${g.nodeIds.length}): ${formatIdList(g.nodeIds, 20)}`);
    }
    out.push('');
  }

  const bm = screenState?.bookmark ?? null;
  if (bm) {
    out.push('BOOKMARK (active advanced view)');
    out.push(`  ${bm.name}${bm.source ? ` [${bm.source}]` : ''} — allowlist ${bm.allowlistNodeIds.length} node(s)`);
    out.push(`  Nodes: ${formatIdList(bm.allowlistNodeIds)}`);
    out.push('');
  }

  return out.join('\n');
}
