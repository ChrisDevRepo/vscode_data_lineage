// @vitest-environment jsdom
/**
 * Pins that the AI badge and footnote render as in-DOM children of the node's own box, never a
 * portal, with the node gap applied in CSS relative to that box, so they scale with the graph zoom.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiBadgeToolbar, AiNoteToolbar, AI_ANNOTATION_NODE_GAP } from '../../../src/components/AiNodeAnnotations';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/** Node-box wrapper matching the shape `CustomNode`/`ColumnTraceNode` render around a badge/note. */
function NodeBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="ln-node-card" style={{ position: 'relative', width: 180, height: 70 }}>
      {children}
    </div>
  );
}

describe('AiBadgeToolbar / AiNoteToolbar render inside the node box', () => {
  it('renders the badge as a plain in-DOM child of the node box, never a portal', () => {
    act(() => {
      root.render(
        <NodeBox>
          <AiBadgeToolbar text="1 Upstream — all levels" />
        </NodeBox>
      );
    });
    const nodeBox = host.querySelector('.ln-node-card') as HTMLElement;
    const chip = nodeBox.querySelector('.ln-ai-badge') as HTMLElement;
    expect(chip).not.toBeNull();
    // A NodeToolbar (or any floating-ui/portal) mounts the badge chip into a sibling of <body>,
    // never inside the node's own element — the failure mode this test would catch if the portal
    // came back. (The Tooltip's own hover-text popup is a separate, always-present portal
    // container and is not the chip under test.)
    expect(document.querySelectorAll('.ln-ai-badge').length).toBe(1);
    expect(document.body.contains(chip)).toBe(true);
    expect(host.contains(chip)).toBe(true);
  });

  it('positions the badge above the node box with the shared gap constant, in the box coordinate space', () => {
    act(() => {
      root.render(
        <NodeBox>
          <AiBadgeToolbar text="1 Upstream — all levels" />
        </NodeBox>
      );
    });
    const badgeWrapper = host.querySelector('.ln-node-card > div') as HTMLElement;
    expect(badgeWrapper.style.position).toBe('absolute');
    expect(badgeWrapper.style.bottom).toBe(`calc(100% + ${AI_ANNOTATION_NODE_GAP}px)`);
  });

  it('renders the footnote as a plain in-DOM child of the node box, positioned below it', () => {
    act(() => {
      root.render(
        <NodeBox>
          <AiNoteToolbar text="Derived from dbo.SalesOrderDetail" />
        </NodeBox>
      );
    });
    const nodeBox = host.querySelector('.ln-node-card') as HTMLElement;
    const note = nodeBox.querySelector('.ln-ai-note-label') as HTMLElement;
    expect(note).not.toBeNull();
    const noteWrapper = host.querySelector('.ln-node-card > div') as HTMLElement;
    expect(noteWrapper.style.position).toBe('absolute');
    expect(noteWrapper.style.top).toBe(`calc(100% + ${AI_ANNOTATION_NODE_GAP}px)`);
    expect(document.querySelectorAll('.ln-ai-note-label').length).toBe(1);
    expect(host.contains(note)).toBe(true);
  });
});
