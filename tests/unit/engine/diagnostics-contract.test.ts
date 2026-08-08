import { describe, expect, it } from 'vitest';
import { DetailPanelToExtensionMsgSchema } from '../../../src/engine/shared/bridgeContract';

describe('detail-panel diagnostics contract', () => {
  it.each([
    { type: 'error', error: 'render failed', source: 'error-boundary' },
    { type: 'show-warning', text: 'profiling is unavailable' },
  ])('accepts $type messages handled by the shared diagnostic funnel', (message) => {
    expect(DetailPanelToExtensionMsgSchema.safeParse(message).success).toBe(true);
  });

  it('still rejects unknown detail-panel messages', () => {
    expect(DetailPanelToExtensionMsgSchema.safeParse({ type: 'log', text: 'raw' }).success).toBe(false);
  });
});
