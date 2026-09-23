// Pins the canvas thresholds: virtualization only above VIRTUALIZATION_NODE_THRESHOLD nodes, no edge
// animation above EDGE_ANIMATION_COUNT_THRESHOLD edges, and a MIN_CANVAS_ZOOM below the plain-node zoom
// so fitView can always contain every node.
import { describe, expect, it } from 'vitest';
import {
  EDGE_ANIMATION_COUNT_THRESHOLD,
  MIN_CANVAS_ZOOM,
  shouldAnimateEdges,
  shouldVirtualizeCanvas,
  SIMPLE_NODE_ZOOM_THRESHOLD,
  VIRTUALIZATION_NODE_THRESHOLD,
} from '../../../src/engine/nodeDecoration';

describe('shouldVirtualizeCanvas', () => {
  it('stays off at and below the threshold', () => {
    expect(shouldVirtualizeCanvas(VIRTUALIZATION_NODE_THRESHOLD - 1)).toBe(false);
    expect(shouldVirtualizeCanvas(VIRTUALIZATION_NODE_THRESHOLD)).toBe(false);
  });

  it('turns on one node past the threshold', () => {
    expect(shouldVirtualizeCanvas(VIRTUALIZATION_NODE_THRESHOLD + 1)).toBe(true);
  });
});

describe('shouldAnimateEdges', () => {
  it('respects config off regardless of edge count', () => {
    expect(shouldAnimateEdges(1, false)).toBe(false);
    expect(shouldAnimateEdges(EDGE_ANIMATION_COUNT_THRESHOLD - 1, false)).toBe(false);
  });

  it('animates at and below the threshold when config allows it', () => {
    expect(shouldAnimateEdges(EDGE_ANIMATION_COUNT_THRESHOLD - 1, true)).toBe(true);
    expect(shouldAnimateEdges(EDGE_ANIMATION_COUNT_THRESHOLD, true)).toBe(true);
  });

  it('turns off one edge past the threshold even when config allows it', () => {
    expect(shouldAnimateEdges(EDGE_ANIMATION_COUNT_THRESHOLD + 1, true)).toBe(false);
  });
});

describe('MIN_CANVAS_ZOOM', () => {
  it('stays below the plain-node zoom threshold, so a fit that needs to zoom out past it still renders a legible (plain-box) map instead of clamping and leaving nodes outside the pane', () => {
    expect(MIN_CANVAS_ZOOM).toBeLessThan(SIMPLE_NODE_ZOOM_THRESHOLD);
  });
});
