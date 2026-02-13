# Implementation Plan: Advanced Graph Analysis Panel

## Summary

Add a "Graph Analysis" dropdown to the toolbar that opens a reusable left sidebar panel (same slot as Detail Search) showing categorized analysis results: **Orphan Nodes**, **Small Islands**, and **Large Hubs**. Results are grouped in a swappable hierarchy (Schema > Object Type or vice versa), with in/out degree counts and click-to-center navigation.

---

## Architecture Decision: Maximum Reuse, Minimum Code

### Key Insight
The existing `DetailSearchSidebar` pattern (150 lines) proves the UI pattern: a left `<Panel position="top-left">` inside ReactFlow with grouped `<details>` sections and click-to-center. Rather than duplicating this, we create a **single generic `AnalysisSidebar`** component that replaces the search input with an analysis-type header and reuses the same grouping/navigation pattern.

### Library Usage (Don't Reinvent the Wheel)
- **`graphology-components`** (new dep) — `connectedComponents()` returns weakly connected components for directed graphs. This is exactly what "islands" are.
- **`graph.degree()` / `graph.inDegree()` / `graph.outDegree()`** — already available from graphology core for hub detection.
- **Orphans** — already detected in `useGraphology.ts:applyIsolationFilter` via edge membership. For analysis we use `graph.degree(node) === 0`.

---

## Naming Conventions (Graph Theory Standard)

| Feature | Label | Graph Term | Description |
|---------|-------|------------|-------------|
| Orphans | Orphan Nodes | Isolated vertices | Nodes with degree 0 (no edges) |
| Islands | Small Islands | Small connected components | Components with ≤ N nodes |
| Hubs | Large Hubs | High-degree nodes | Nodes with total degree ≥ N |

Dropdown label: **"Analyze"** (concise, matches VS Code conventions like "Run", "Debug")

---

## Detailed Implementation Plan

### Step 1: Add `graphology-components` dependency
**File**: `package.json`
**Change**: Add `"graphology-components": "^1.5.4"` to dependencies
**Lines**: ~1

### Step 2: Add settings for thresholds
**File**: `package.json` (contributes.configuration.properties)
**Change**: Add two new settings:
```json
"dataLineageViz.analysis.smallIslandMaxNodes": {
  "type": "number", "default": 3, "minimum": 2, "maximum": 20,
  "description": "Maximum node count for a connected component to be classified as a 'small island'."
},
"dataLineageViz.analysis.largeHubMinDegree": {
  "type": "number", "default": 8, "minimum": 3, "maximum": 50,
  "description": "Minimum total degree (in + out) for a node to be classified as a 'large hub'."
}
```
**Lines**: ~20

### Step 3: Extend config types and read settings
**File**: `src/engine/types.ts`
**Change**: Add `AnalysisConfig` interface and extend `ExtensionConfig`:
```typescript
export type AnalysisType = 'orphans' | 'smallIslands' | 'largeHubs';

export interface AnalysisConfig {
  smallIslandMaxNodes: number;
  largeHubMinDegree: number;
}

// Add to ExtensionConfig:
analysis: AnalysisConfig;

// Add to DEFAULT_CONFIG:
analysis: { smallIslandMaxNodes: 3, largeHubMinDegree: 8 }
```
**Lines**: ~12

**File**: `src/extension.ts`
**Change**: Read the two new settings in `readExtensionConfig()`:
```typescript
analysis: {
  smallIslandMaxNodes: cfg.get<number>('analysis.smallIslandMaxNodes', 3),
  largeHubMinDegree: cfg.get<number>('analysis.largeHubMinDegree', 8),
}
```
**Lines**: ~5

### Step 4: Add analysis computation functions
**File**: `src/engine/graphBuilder.ts`
**Change**: Add `computeAnalysis()` using graphology + graphology-components:

```typescript
import { connectedComponents } from 'graphology-components';

export interface AnalysisNode {
  id: string;
  name: string;
  schema: string;
  type: ObjectType;
  inDegree: number;
  outDegree: number;
  componentId?: number;  // for islands
}

export interface AnalysisResult {
  type: AnalysisType;
  label: string;
  nodes: AnalysisNode[];
}

export function computeAnalysis(
  graph: Graph,
  analysisType: AnalysisType,
  config: AnalysisConfig
): AnalysisResult { ... }
```

Implementation:
- **Orphans**: `graph.forEachNode` → filter `graph.degree(node) === 0`
- **Small Islands**: `connectedComponents(graph)` → filter components with `length <= config.smallIslandMaxNodes`, return all nodes in those components
- **Large Hubs**: `graph.forEachNode` → filter `graph.degree(node) >= config.largeHubMinDegree`, sorted by degree descending

**Lines**: ~55

### Step 5: Create `AnalysisSidebar` component (NEW FILE)
**File**: `src/components/AnalysisSidebar.tsx`
**Pattern**: Mirror `DetailSearchSidebar.tsx` structure exactly

Key features:
- Header with analysis type label + close button (same style as DetailSearchSidebar)
- Toggle for grouping order: "Schema > Type" vs "Type > Schema" (single swap button)
- Two-level `<details>` hierarchy:
  - Level 1: Schema name (or Object Type)
  - Level 2: Object Type (or Schema name)
  - Items: `[schema].[name]` with `In: N  Out: N` badge
- Click handler → `onResultClick(nodeId)` (same interface as DetailSearchSidebar)
- Total count at bottom (same pattern)
- Uses existing CSS variables (`--ln-sidebar-header-bg`, `--ln-fg`, etc.)

**Lines**: ~130

### Step 6: Add "Analyze" dropdown to Toolbar
**File**: `src/components/Toolbar.tsx`
**Change**: Add a dropdown button between Detail Search and Schema Filter:

```tsx
// New dropdown button with chart-bar icon (graph analysis)
// Dropdown shows 3 items:
//   - Orphan Nodes (with count from metrics)
//   - Small Islands (≤ {threshold} nodes)
//   - Large Hubs (≥ {threshold} degree)
// onClick → calls onSelectAnalysis(type)
// Active state when analysis panel is open (same as Detail Search toggle)
```

Uses same dropdown pattern as `SchemaFilterDropdown` / `TypeFilterDropdown`.

**Lines**: ~40 (inline in Toolbar, no new file needed)

### Step 7: Wire up in GraphCanvas
**File**: `src/components/GraphCanvas.tsx`
**Change**:
- Add `AnalysisSidebar` as alternative content in the `<Panel position="top-left">` slot
- When analysis is active, show AnalysisSidebar instead of DetailSearchSidebar
- Reuse the exact same `onResultClick` handler (center + highlight)

```tsx
<Panel position="top-left">
  {isDetailSearchOpen && <DetailSearchSidebar ... />}
  {activeAnalysis && <AnalysisSidebar ... />}
</Panel>
```

**Lines**: ~20

### Step 8: Add state management in App.tsx
**File**: `src/components/App.tsx`
**Change**:
- Add `activeAnalysis: AnalysisType | null` state
- `handleSelectAnalysis(type)` → computes results, sets state, closes detail search
- `handleCloseAnalysis()` → clears state
- Pass through to GraphCanvas

```typescript
const [activeAnalysis, setActiveAnalysis] = useState<AnalysisType | null>(null);
const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);

const handleSelectAnalysis = useCallback((type: AnalysisType) => {
  if (!graph) return;
  if (activeAnalysis === type) { setActiveAnalysis(null); return; } // toggle off
  setIsDetailSearchOpen(false); // mutual exclusion
  const result = computeAnalysis(graph, type, config.analysis);
  setAnalysisResult(result);
  setActiveAnalysis(type);
}, [graph, config, activeAnalysis]);
```

**Lines**: ~20

---

## Low-Hanging Fruits Identified

1. **Metrics in toolbar already show roots/leaves** — The analysis dropdown can show live counts next to each option (e.g., "Orphan Nodes (12)") computed from the already-available `graph` object, making it immediately useful as a health dashboard.

2. **Mutual exclusion with Detail Search** — Both use `<Panel position="top-left">`. Opening one closes the other. Simple boolean logic, no layout changes.

3. **Click-to-center reuse** — The `handleExecuteSearch` centering logic in `GraphCanvas` (lines 108-129) is identical to what `onResultClick` needs. Extract it or just reuse the same inline callback pattern.

4. **Sort by degree** — Within each group, sort nodes by total degree descending. Users naturally want to see the most connected nodes first. One `.sort()` call.

5. **Component size in Islands** — Show component size badge (e.g., "2 nodes") next to each island group. Trivial since `connectedComponents()` returns arrays.

---

## Multi-Persona Review

### Product Manager Review
- **Value**: Immediate visibility into graph health — orphans indicate incomplete models, islands indicate disconnected subsystems, hubs indicate critical dependencies. All three are actionable insights.
- **Settings**: Thresholds in VS Code settings are correct — power users tune them, defaults work for 90% of cases.
- **Naming**: "Analyze" is clear and concise. "Orphan Nodes", "Small Islands", "Large Hubs" are self-explanatory without being overly technical.
- **Suggestion**: Consider showing counts in the toolbar metrics area when analysis is active (e.g., "12 orphans"). **Decision**: Defer — counts are already visible in the dropdown and sidebar header.

### UX Designer Review
- **Consistency**: Reuses the exact same left panel slot, same header style, same click-to-center behavior as Detail Search. Users learn one pattern.
- **Hierarchy swap**: The Schema > Type toggle satisfies users who think "show me all orphan tables" vs "show me everything in dbo that's orphaned". One toggle, not a complex sort UI.
- **Discoverability**: Chart-bar icon with dropdown is standard. Active state (primary variant) matches Detail Search toggle behavior.
- **Concern**: Opening analysis should NOT close existing trace mode — it's purely a navigation overlay. **Decision**: Correct, analysis is read-only navigation, independent of trace state.
- **Concern**: What happens with 0 results? Show an empty state message "No orphan nodes found" with a subtle icon. ~5 lines.

### Web Developer Review
- **New dependency**: `graphology-components` is 12KB minified, maintained by graphology core team, no transitive deps beyond graphology-utils. Safe addition.
- **Performance**: `connectedComponents()` is O(V+E), same as BFS already used in tracing. No concern for graphs up to maxNodes=1000.
- **State**: Single `AnalysisResult` object computed on-demand (not in a useEffect). Avoids stale cache issues. Re-computed when user clicks analysis type.
- **Memoization**: `AnalysisSidebar` should be `memo()` like `DetailSearchSidebar`. Grouping logic via `useMemo`.
- **Bundle**: Analysis sidebar is ~130 lines. No lazy loading needed — it's smaller than existing components.

### Database Developer Review
- **Orphan nodes** = tables/views with no procedures referencing them. Critical for identifying dead objects.
- **Small islands** = disconnected subsystems (e.g., a staging table only used by one SP). Useful for migration planning.
- **Large hubs** = tables joined by many procedures. These are the "hot tables" — schema changes here have wide blast radius.
- **Suggestion**: Show degree breakdown (in vs out) in the sidebar because `In: 15, Out: 0` means "everyone reads from this table" vs `In: 0, Out: 8` means "this procedure writes everywhere". **Decision**: Already planned — showing `In: N  Out: N` per node.

### Graphology SME Review
- **`connectedComponents(graph)`**: Returns `string[][]` (arrays of node IDs). For directed graphs, these are *weakly* connected components (ignoring edge direction). This is correct for "islands" — we want structural connectivity regardless of data flow direction.
- **Degree functions**: `graph.degree(n)` = `inDegree + outDegree`. For hub detection this is the right metric (not just inDegree or outDegree).
- **No need for**: `graphology-metrics` (we only need degree which is built-in), `graphology-communities` (overkill for this use case), `graphology-shortest-path` (not needed).
- **Edge case**: If `hideIsolated` filter is active, orphan nodes are already hidden from the graph. Analysis should run on the **current graph** (post-filter), not the raw model. This is already the case since we pass the `graph` from `useGraphology`.

---

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| `graphology-components` API change | Low | Pin to ^1.5.4, stable package (no breaking changes since v1.0) |
| Performance on large graphs | Low | All algorithms are O(V+E), maxNodes is capped at 1000 |
| Analysis on filtered vs full graph | Medium | Document behavior: analysis reflects current filter state. Add note in sidebar header. |
| Mutual exclusion bugs (detail search vs analysis) | Low | Simple boolean state — opening one sets the other to false/null |

---

## Effort Estimate

| File | Type | Lines Changed/Added | Complexity |
|------|------|---------------------|------------|
| `package.json` | Modify | ~21 | Trivial |
| `src/engine/types.ts` | Modify | ~12 | Trivial |
| `src/extension.ts` | Modify | ~5 | Trivial |
| `src/engine/graphBuilder.ts` | Modify | ~55 | Low |
| `src/components/AnalysisSidebar.tsx` | **New** | ~130 | Medium |
| `src/components/Toolbar.tsx` | Modify | ~40 | Low |
| `src/components/GraphCanvas.tsx` | Modify | ~20 | Low |
| `src/components/App.tsx` | Modify | ~20 | Low |
| **Total** | **8 files (1 new)** | **~303 lines** | **Low-Medium** |

---

## File Dependency Order (Implementation Sequence)

1. `package.json` (add dep + settings)
2. `npm install` (get graphology-components)
3. `src/engine/types.ts` (types first)
4. `src/extension.ts` (config reading)
5. `src/engine/graphBuilder.ts` (analysis logic)
6. `src/components/AnalysisSidebar.tsx` (new UI)
7. `src/components/Toolbar.tsx` (dropdown trigger)
8. `src/components/GraphCanvas.tsx` + `App.tsx` (wiring)
