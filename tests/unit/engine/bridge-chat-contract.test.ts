/** The chat frames of the bridge contract: what the host accepts from the webview and what it may send. */
import { describe, expect, it } from 'vitest';
import {
  ExtensionToWebviewMsgSchema,
  MainPanelToExtensionMsgSchema,
} from '../../../src/engine/shared/bridgeContract';

describe('chat frames from the webview', () => {
  it.each([
    { type: 'chat.send', text: '/search orders' },
    { type: 'chat.cancel', turnId: 's:r' },
    { type: 'chat.gate', turnId: 's:r', gateId: 'g', decision: 'approve' },
    { type: 'chat.gate', turnId: 's:r', gateId: 'g', decision: 'refine', text: 'exclude staging' },
    { type: 'chat.newChat' },
    { type: 'chat.selectModel', modelId: 'cloud' },
    { type: 'chat.selectEffort', effort: 'high' },
    { type: 'chat.ready' },
  ])('accepts %j', (msg) => {
    expect(MainPanelToExtensionMsgSchema.safeParse(msg).success).toBe(true);
  });

  it.each<[string, unknown]>([
    ['an unknown chat type', { type: 'chat.delete' }],
    ['an empty prompt', { type: 'chat.send', text: '' }],
    ['an oversized prompt', { type: 'chat.send', text: 'x'.repeat(50_001) }],
    ['a gate without gateId', { type: 'chat.gate', turnId: 't', decision: 'approve' }],
    ['a gate with an unknown decision', { type: 'chat.gate', turnId: 't', gateId: 'g', decision: 'hold' }],
    ['a refine without text', { type: 'chat.gate', turnId: 't', gateId: 'g', decision: 'refine' }],
    ['a refine with blank text', { type: 'chat.gate', turnId: 't', gateId: 'g', decision: 'refine', text: '  ' }],
    ['a cancel without turnId', { type: 'chat.cancel' }],
  ])('rejects %s', (_name, msg) => {
    expect(MainPanelToExtensionMsgSchema.safeParse(msg).success).toBe(false);
  });
});

describe('chat frames to the webview', () => {
  it('validates event, state and history frames inside the one webview union', () => {
    const frames: unknown[] = [
      { type: 'chat.event', turnId: 't', event: { type: 'text', delta: 'a' } },
      { type: 'chat.event', turnId: 't', event: { type: 'gate', gateId: 'g', gate: 'confirm_sm_start', summary: 's', classes: ['x'] }, replacesAnalysis: true },
      { type: 'chat.state', models: [{ id: 'a', name: 'A', supportsReasoningEffort: ['low'], reasoningEffort: 'low' }], selectedModelId: 'a', effort: 'low', busy: false },
      { type: 'chat.history', messages: [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a' }] },
    ];
    for (const frame of frames) expect(ExtensionToWebviewMsgSchema.safeParse(frame).success).toBe(true);
    expect(ExtensionToWebviewMsgSchema.safeParse({ type: 'chat.event', turnId: 't', event: { type: 'bogus' } }).success).toBe(false);
  });

  it('defaults the state followups to none and keeps the ones sent', () => {
    const state = { type: 'chat.state', models: [], selectedModelId: '', busy: false };
    expect(ExtensionToWebviewMsgSchema.parse(state)).toMatchObject({ followups: [] });
    const followups = [{ label: 'Show full description', prompt: 'Show the full description' }];
    expect(ExtensionToWebviewMsgSchema.parse({ ...state, followups })).toMatchObject({ followups });
    expect(ExtensionToWebviewMsgSchema.safeParse({ ...state, followups: [{ label: 'x' }] }).success).toBe(false);
  });
});
