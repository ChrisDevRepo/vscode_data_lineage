/** The terminal chat/render contract: delivery is delivered / no_panel / post_failed, and the chat text follows it. */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as VSCode from 'vscode';
import { buildModel, normalizeName } from '../../../src/engine/modelBuilder';
import { buildGraphologyGraph } from '../../../src/engine/graphBuilder';
import { AiSession } from '../../../src/ai/session/session';
import { EMPTY_AI_TEMPLATES } from '../../../src/ai/session/types';
import { LineageRuntime } from '../../../src/ai/runtime/lineageRuntime';
import { TurnEventSink, type TurnEvent } from '../../../src/ai/runtime/turnEventSink';
import { buildAiToolRegistry, deliverToPanel } from '../../../src/ai/tools/toolProvider';
import { executePresentResult } from '../../../src/ai/tools/handlers/presentResult';
import type { ToolServices } from '../../../src/ai/tools/handlers/toolServices';
import { buildChatAnswer, type PreviewDelivery } from '../../../src/ai/support/chatAnswer';
import { modelToolCallMessage, type ModelPort } from '../../../src/ai/model/modelPort';
import { DEFAULT_TURN_TOKEN_BUDGET } from '../../../src/ai/support/tokenBudget';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { loadParseRules } from '../helpers/testUtils';

// The bridge's schema validation is owned and tested at the host; here its boolean verdict is the panel's own post result.
vi.mock('../../../src/bridge/host', () => ({
  postToWebview: (panel: VSCode.WebviewPanel, msg: unknown) => panel.webview.postMessage(msg),
}));

beforeAll(() => { loadParseRules(); });

const NOTICE = 'The AI preview could not be rendered';
const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const silentLogger = silent as unknown as Parameters<typeof deliverToPanel>[2];

describe('deliverToPanel names the delivery outcome', () => {
  const message = { type: 'ai-view-preview', name: 'Report lineage', nodeIds: ['dbo.report'], aiMetadata: {} } as never;
  const panelWith = (post: () => Promise<boolean>) => ({ reveal: vi.fn(), webview: { postMessage: vi.fn(post) } }) as unknown as VSCode.WebviewPanel;

  it('reports no_panel when no panel is open', async () => {
    expect(await deliverToPanel(undefined, message, silentLogger)).toBe('no_panel');
  });

  it('reports post_failed when the webview refuses the post', async () => {
    const panel = panelWith(async () => false);
    expect(await deliverToPanel(panel, message, silentLogger)).toBe('post_failed');
    expect(panel.reveal).toHaveBeenCalledTimes(1);
  });

  it('reports delivered when the webview accepts the post', async () => {
    const panel = panelWith(async () => true);
    expect(await deliverToPanel(panel, message, silentLogger)).toBe('delivered');
    expect(panel.reveal).toHaveBeenCalledTimes(1);
  });
});

function presentWorld(deliverPreview: (session: AiSession) => Promise<PreviewDelivery>) {
  const id = (name: string) => normalizeName(`dbo.${name}`, false);
  const origin = id('Report'), source = id('Source');
  const model = buildModel([
    { fullName: '[dbo].[Report]', type: 'view', bodyScript: 'SELECT Value FROM dbo.Source', columns: [{ name: 'Value', type: 'int', nullable: 'NULL', extra: '' }] },
    { fullName: '[dbo].[Source]', type: 'table' },
  ], [], undefined, undefined, true, undefined, false);
  const session = new AiSession();
  const epoch = session.beginTurn();
  session.resultGraph = { nodeIds: [origin, source], edges: [[source, origin, 'read']], source: 'blackboard', originNodeId: origin };
  session.enterCompleted(epoch);
  const services = {
    getSession: () => session, turnEpoch: () => epoch, requireModel: () => model, logger: silent,
    budget: DEFAULT_TURN_TOKEN_BUDGET, deliverPreview: vi.fn(() => deliverPreview(session)),
    logAndReturn: (_name: string, data: object) => JSON.stringify(data),
    toolError: (_name: string, error: unknown) => { throw error; },
  } as unknown as ToolServices;
  const present = async () => JSON.parse(await executePresentResult({ name: 'Report lineage', summary: 'Report reads Source.', is_update: true,
    sections: [{ label: 'Sources', node_ids: [origin, source], text: 'Source supplies the report.' }],
    highlight_groups: [{ label: 'Origin', color: 'target', node_ids: [origin] }] }, services));
  return { session, present };
}

describe('present_result records the delivery outcome', () => {
  it('delivered: the artifact is auto-dispatched and the render is clean', async () => {
    const { session, present } = presentWorld(async () => 'delivered');
    expect(await present()).toMatchObject({ success: true });
    expect(session.presentResultAutoDispatched).toBe(true);
    expect(session.synthesisRenderDegradedReason).toBeNull();
  });

  it('no_panel: deferred to the button, not auto-dispatched and not degraded', async () => {
    const { session, present } = presentWorld(async () => 'no_panel');
    expect(await present()).toMatchObject({ success: true });
    expect(session.presentResultAutoDispatched).toBe(false);
    expect(session.synthesisRenderDegradedReason).toBeNull();
  });

  it('post_failed: marked degraded by name and not auto-dispatched', async () => {
    const { session, present } = presentWorld(async () => 'post_failed');
    expect(await present()).toMatchObject({ success: true });
    expect(session.presentResultAutoDispatched).toBe(false);
    expect(session.synthesisRenderDegradedReason).toBe('preview_post_failed');
  });

  it('a thrown dispatch stays degraded under its own name', async () => {
    const { session, present } = presentWorld(async () => { throw new Error('transport'); });
    expect(await present()).toMatchObject({ success: true });
    expect(session.presentResultAutoDispatched).toBe(false);
    expect(session.synthesisRenderDegradedReason).toBe('preview_dispatch');
  });
});

describe('the latest present decides the delivery outcome of the turn', () => {
  const outcomes = (...sequence: Array<PreviewDelivery | 'throw'>) => {
    const queue = [...sequence];
    return async () => { const next = queue.shift()!; if (next === 'throw') throw new Error('transport'); return next; };
  };

  it('a delivered present after a failed post clears the degraded mark', async () => {
    const { session, present } = presentWorld(outcomes('post_failed', 'delivered'));
    await present();
    expect(session.synthesisRenderDegradedReason).toBe('preview_post_failed');
    await present();
    expect(session.presentResultAutoDispatched).toBe(true);
    expect(session.synthesisRenderDegradedReason).toBeNull();
  });

  it('a deferred (no_panel) present after a thrown dispatch clears the degraded mark', async () => {
    const { session, present } = presentWorld(outcomes('throw', 'no_panel'));
    await present();
    expect(session.synthesisRenderDegradedReason).toBe('preview_dispatch');
    await present();
    expect(session.synthesisRenderDegradedReason).toBeNull();
  });

  it('a failed post after a delivered present marks the turn degraded', async () => {
    const { session, present } = presentWorld(outcomes('delivered', 'post_failed'));
    await present();
    await present();
    expect(session.synthesisRenderDegradedReason).toBe('preview_post_failed');
  });

  it('a degraded mark from a different cause is not cleared by a delivered post', async () => {
    const { session, present } = presentWorld(outcomes('delivered'));
    session.markSynthesisRenderDegraded('synthesis_breaker');
    await present();
    expect(session.synthesisRenderDegradedReason).toBe('synthesis_breaker');
  });

  it('a stale turn whose post failed does not mark the newer turn degraded', async () => {
    const { session, present } = presentWorld(async s => { s.beginTurn(); return 'post_failed'; });
    expect(await present()).toMatchObject({ code: 'stale_turn' });
    expect(session.synthesisRenderDegradedReason).toBeNull();
  });
});

describe('buildChatAnswer follows the delivery outcome', () => {
  const parts = {
    summary: 'Report reads Source.',
    intro: 'Intro paragraph.',
    closing: '---\n\nClosing paragraph.',
    description: '# Report lineage\n\nIntro paragraph.\n\n## 1 Sources\n\nSource supplies the report.\n\n---\n\nClosing paragraph.',
  };

  it('delivered: the authored summary only', () => {
    expect(buildChatAnswer(parts, 'delivered')).toBe('Report reads Source.');
  });

  it('post_failed: the summary followed by the whole assembled preview, sections included, nothing cut', () => {
    expect(buildChatAnswer(parts, 'post_failed')).toBe(`Report reads Source.\n\n${parts.description}`);
  });

  it('post_failed without an assembled description: the authored summary, intro and closing, never empty', () => {
    expect(buildChatAnswer({ ...parts, description: null }, 'post_failed')).toBe('Report reads Source.\n\nIntro paragraph.\n\nClosing paragraph.');
    expect(buildChatAnswer({ summary: 'Only a summary.' }, 'post_failed')).toBe('Only a summary.');
  });

  it('delivered with a blank summary still shows the authored text', () => {
    expect(buildChatAnswer({ ...parts, summary: '  ' }, 'delivered')).toBe('Intro paragraph.\n\nClosing paragraph.');
  });

  it('no_panel: the deferred text is unchanged (summary, intro, closing)', () => {
    expect(buildChatAnswer(parts, 'no_panel')).toBe('Report reads Source.\n\nIntro paragraph.\n\nClosing paragraph.');
  });

  it('returns null only when nothing is authored', () => {
    expect(buildChatAnswer({}, 'post_failed')).toBeNull();
    expect(buildChatAnswer({}, 'delivered')).toBeNull();
  });
});

describe('terminal chat text through the real runtime', () => {
  const SUMMARY = 'Report reads Source.';
  const INTRO = 'Intro paragraph unique-intro.';
  const CLOSING = 'Closing paragraph unique-closing.';
  const SECTION = 'Source supplies the report unique-section.';

  function catalog() {
    const columns = [{ name: 'Value', type: 'int', nullable: 'NOT NULL', extra: '' }];
    const objects = [
      { fullName: '[dbo].[Report]', type: 'view' as const, columns, bodyScript: 'CREATE VIEW dbo.Report AS SELECT s.Value FROM dbo.Source s;' },
      { fullName: '[dbo].[Source]', type: 'table' as const, columns },
    ];
    return buildModel(objects, [], objects, undefined, false, undefined, false);
  }

  /** One session, one scripted model: the first run explores and presents, the second is a completed-phase follow-up. */
  async function runBoth(getPanel: () => VSCode.WebviewPanel | undefined) {
    const model = catalog();
    const session = new AiSession({ ...EMPTY_AI_TEMPLATES, technical_capture: 'Capture the supplied SQL.', structural_summary: 'Describe source columns.' });
    session.model = model;
    session.graph = buildGraphologyGraph(model);
    let followUp = false;
    let providerCalls = 0;
    const present = (summary: string) => {
      const ids = session.resultGraph!.nodeIds;
      return { name: 'Report lineage', summary, ...(followUp ? { is_update: true } : {}), intro: INTRO, closing: CLOSING,
        sections: [{ label: 'Sources', node_ids: ids, text: SECTION }],
        highlight_groups: [{ label: 'Lineage', color: 'source', node_ids: ids }] };
    };
    const scripted: ModelPort = {
      id: 'fixed-render-contract', identity: { id: 'fixed-render-contract', name: 'Fixed', vendor: 'test', family: 'test', version: '1' },
      budget: DEFAULT_TURN_TOKEN_BUDGET,
      get modelCalls() { return providerCalls; },
      async getNumTokens(content) { return String(content).length; },
      async generateStructured() { throw new Error('Slash routing must not call entry classification.'); },
      async completeText() { providerCalls++; return 'Trace the supplied catalog.'; },
      async generateToolTurn(input) {
        providerCalls++;
        let toolName: string;
        let payload: Record<string, unknown>;
        if (followUp) {
          toolName = 'lineage_present_result';
          payload = present(SUMMARY);
        } else if (input.tools.some(tool => tool.name === 'lineage_start_exploration')) {
          toolName = 'lineage_start_exploration';
          payload = { origin: 'DBO.REPORT', analysisMode: 'bb', classification: 'technical',
            depth: { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } } };
        } else if (input.tools.some(tool => tool.name === 'lineage_submit_findings')) {
          toolName = 'lineage_submit_findings';
          const engine = session.stateMachine!;
          if (!(engine instanceof NavigationEngine)) throw new Error('Active phase requires the production navigation engine.');
          const focus = engine.currentFocus!;
          payload = { focus_node_id: focus, verdict: 'analyze', summary: `Records ${focus}.`, sections: { technical: `Observed ${focus}.` } };
        } else {
          toolName = 'lineage_present_result';
          payload = present(SUMMARY);
        }
        const call = { valid: true as const, callId: `call-${providerCalls}`, toolName, input: payload };
        return { status: 'completed' as const, content: [], message: modelToolCallMessage([call]), text: '', toolCalls: [call], finishReason: 'tool-calls' };
      },
    };
    const channel = silent as unknown as Parameters<typeof buildAiToolRegistry>[1];
    const runtime = new LineageRuntime({ getSession: () => session,
      createRegistry: (lease, port) => buildAiToolRegistry(() => session, channel, getPanel, lease, { model: port }),
    });
    const run = async (id: string, prompt: string) => {
      const events: TurnEvent[] = [];
      const result = await runtime.run({ model: scripted, request: { id, prompt },
        sink: new TurnEventSink(event => { events.push(event); if (event.type === 'gate') void runtime.resumeGate(event.gateId, { kind: 'approve', classes: [...event.classes ?? []] }); }) });
      const text = events.flatMap(event => event.type === 'text' ? [event.delta] : []).join('');
      return { result, events, text };
    };
    const first = await run('render-1', '/trace [dbo].[Report]');
    expect(first.result, JSON.stringify(first.events)).toMatchObject({ outcome: 'ok' });
    followUp = true;
    const second = await run('render-2', 'Update the view with the same sources.');
    return { session, first, second };
  }

  const panelPosting = (accepted: boolean) => () => ({ reveal: () => {}, webview: { postMessage: async () => accepted } }) as unknown as VSCode.WebviewPanel;

  it('delivered: both terminals chat the authored summary only and no failure notice', async () => {
    const { first, second } = await runBoth(panelPosting(true));
    for (const { text } of [first, second]) {
      expect(text).toContain(SUMMARY);
      expect(text).not.toContain('unique-');
      expect(text).not.toContain(NOTICE);
    }
  });

  it('post_failed: both terminals chat the whole preview once, then the failed notice, and mark degraded', async () => {
    const { session, first, second } = await runBoth(panelPosting(false));
    for (const { text } of [first, second]) {
      for (const authored of [SUMMARY, INTRO, SECTION, CLOSING]) expect(text.split(authored)).toHaveLength(2);
      expect(text.split(NOTICE)).toHaveLength(2);
      expect(text.indexOf(NOTICE)).toBeGreaterThan(text.indexOf(CLOSING));
    }
    expect(session.synthesisRenderDegradedReason).toBe('preview_post_failed');
  });

  it('post_failed: the chatted preview names its objects without overlay-only links or a heading-scale object list', async () => {
    const { session, first, second } = await runBoth(panelPosting(false));
    expect(session.lastPresentResultDescription, 'the assembled preview carries overlay object links').toContain('](#focus-node:');
    for (const { text } of [first, second]) {
      expect(text).not.toContain('#focus-node:');
      expect(text).not.toContain('### Objects');
      expect(text).toMatch(/^\*Objects: .*Report.*\*$/m);
    }
  });

  it('no_panel: the deferred text is chatted without the failure notice and without a degraded mark', async () => {
    const { session, first, second } = await runBoth(() => undefined);
    for (const { text } of [first, second]) {
      expect(text).toContain(SUMMARY);
      expect(text).toContain(INTRO);
      expect(text).toContain(CLOSING);
      expect(text).not.toContain(NOTICE);
    }
    expect(session.synthesisRenderDegradedReason).toBeNull();
    expect(session.presentResultAutoDispatched).toBe(false);
  });
});
