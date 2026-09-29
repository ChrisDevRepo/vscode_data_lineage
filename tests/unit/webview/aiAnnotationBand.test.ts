// @vitest-environment jsdom
/**
 * Pins that the AI badge/footnote keep a clear gap from the node box, and that the layout band
 * reserved above and below an annotated node covers that gap plus the label itself.
 */
import { describe, expect, it } from 'vitest';
import { AI_ANNOTATION_NODE_GAP } from '../../../src/components/AiNodeAnnotations';
import { AI_BADGE_BAND, AI_NOTE_BAND } from '../../../src/engine/graphBuilder';

/** Smallest gap at which the badge/footnote reads as separated from the node box, not touching it. */
const MIN_CLEAR_GAP = 4;

/** Floor for a single-line 9-10px label's height; jsdom cannot measure the exact pixel height. */
const MIN_CHIP_CONTENT_HEIGHT = 12;

describe('AI badge/footnote node gap', () => {
  it('keeps a clear gap from the node box, not a hairline offset', () => {
    expect(AI_ANNOTATION_NODE_GAP).toBeGreaterThanOrEqual(MIN_CLEAR_GAP);
  });
});

describe('AI badge/footnote layout band vs. the toolbar gap', () => {
  it('reserves more than the gap above an annotated node, with room for the badge itself', () => {
    expect(AI_BADGE_BAND).toBeGreaterThan(AI_ANNOTATION_NODE_GAP);
    expect(AI_BADGE_BAND - AI_ANNOTATION_NODE_GAP).toBeGreaterThanOrEqual(MIN_CHIP_CONTENT_HEIGHT);
  });

  it('reserves more than the gap below an annotated node, with room for the footnote itself', () => {
    expect(AI_NOTE_BAND).toBeGreaterThan(AI_ANNOTATION_NODE_GAP);
    expect(AI_NOTE_BAND - AI_ANNOTATION_NODE_GAP).toBeGreaterThanOrEqual(MIN_CHIP_CONTENT_HEIGHT);
  });
});
