// Zero-dependency Chrome DevTools Protocol client for reading the rendered
// webview from inside an Extension Development Host launched with
// `--remote-debugging-port` (see docs/E2E_TESTING.md). Node 21+ provides global
// `WebSocket` and `fetch`; typed loosely to stay portable across @types/node.
/* eslint-disable @typescript-eslint/no-explicit-any */
const WS: new (url: string) => any = (globalThis as any).WebSocket;
const httpJson = (url: string): Promise<any> => (globalThis as any).fetch(url).then((r: any) => r.json());

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface TargetInfo { targetId: string; type: string; url: string; }

/** A live CDP connection to the EDH browser endpoint with recursive frame auto-attach. */
export class CdpClient {
  private ws: any;
  private id = 0;
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private readonly sessions = new Map<string, TargetInfo>();
  private readonly topTargets = new Map<string, TargetInfo>();
  private readonly consoleErrors: string[] = [];

  private constructor(ws: any) {
    this.ws = ws;
    ws.addEventListener('message', (e: any) => this.onMessage(JSON.parse(e.data)));
  }

  /** Connects to `http://host:port/json/version` → browser WebSocket and starts target discovery. */
  static async connect(port = 9222): Promise<CdpClient> {
    const ver = await httpJson(`http://127.0.0.1:${port}/json/version`);
    const ws = await new Promise<any>((resolve, reject) => {
      const s = new WS(ver.webSocketDebuggerUrl);
      s.addEventListener('open', () => resolve(s));
      s.addEventListener('error', (e: any) => reject(new Error(`CDP ws error: ${e?.message ?? 'unknown'}`)));
    });
    const c = new CdpClient(ws);
    await c.send('Target.setDiscoverTargets', { discover: true });
    return c;
  }

  private onMessage(m: any): void {
    if (m.id && this.pending.has(m.id)) {
      const p = this.pending.get(m.id)!;
      this.pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      return;
    }
    switch (m.method) {
      case 'Target.targetCreated':
        this.topTargets.set(m.params.targetInfo.targetId, m.params.targetInfo);
        break;
      case 'Target.attachedToTarget': {
        const { sessionId, targetInfo, waitingForDebugger } = m.params;
        this.sessions.set(sessionId, targetInfo);
        // Recurse so nested OOPIF webviews surface as their own sessions.
        this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId).catch(() => {});
        if (waitingForDebugger) this.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
        this.send('Runtime.enable', {}, sessionId).catch(() => {});
        break;
      }
      case 'Target.detachedFromTarget':
        this.sessions.delete(m.params.sessionId);
        break;
      case 'Runtime.consoleAPICalled':
        if (m.params.type === 'error') this.consoleErrors.push(this.fmtArgs(m.params.args));
        break;
      case 'Runtime.exceptionThrown':
        this.consoleErrors.push(`EXCEPTION: ${m.params.exceptionDetails?.text ?? ''}`.slice(0, 200));
        break;
      default:
        break;
    }
  }

  private fmtArgs(args: any[]): string {
    return (args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200);
  }

  private send(method: string, params: any = {}, sessionId?: string): Promise<any> {
    const id = ++this.id;
    const payload: any = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }

  /** Attaches to the workbench page so its child frames (webviews) auto-attach. */
  async attachWorkbench(timeoutMs = 15000): Promise<void> {
    const start = Date.now();
    for (;;) {
      const wb = [...this.topTargets.values()].find((t) => t.type === 'page' && /vscode-app/.test(t.url));
      if (wb) {
        const { sessionId } = await this.send('Target.attachToTarget', { targetId: wb.targetId, flatten: true });
        await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
        return;
      }
      if (Date.now() - start > timeoutMs) throw new Error('workbench target not found');
      await sleep(250);
    }
  }

  /** Polls for the `vscode-webview://` iframe session (the panel webview). */
  async findWebviewSession(timeoutMs = 30000): Promise<string> {
    const start = Date.now();
    for (;;) {
      for (const [sid, info] of this.sessions) {
        if (info.type === 'iframe' && /vscode-webview/.test(info.url)) return sid;
      }
      if (Date.now() - start > timeoutMs) throw new Error('webview session not found');
      await sleep(500);
    }
  }

  /**
   * Reads graph metrics from the same-origin `active-frame` inside the webview
   * (where `#root` and React Flow live), polling until nodes render.
   */
  async readActiveFrameMetrics(webviewSession: string, timeoutMs = 30000): Promise<{ hasRoot: boolean; nodeCount: number; edgeCount: number; bodyLen: number; sampleLabels: string[] }> {
    const expression = `(() => {
      const d = document.getElementById('active-frame') && document.getElementById('active-frame').contentDocument;
      if (!d) return { hasRoot:false, nodeCount:0, edgeCount:0, bodyLen:0, sampleLabels:[] };
      const nodes = Array.prototype.slice.call(d.querySelectorAll('.react-flow__node'));
      return {
        hasRoot: !!d.getElementById('root'),
        nodeCount: nodes.length,
        edgeCount: d.querySelectorAll('.react-flow__edge').length,
        bodyLen: (d.body && d.body.innerText || '').length,
        sampleLabels: nodes.slice(0, 5).map((n) => (n.textContent || '').trim().slice(0, 24)),
      };
    })()`;
    const start = Date.now();
    let last: any = { hasRoot: false, nodeCount: 0, edgeCount: 0, bodyLen: 0, sampleLabels: [] };
    for (;;) {
      const ev = await this.send('Runtime.evaluate', { expression, returnByValue: true }, webviewSession);
      last = ev.result?.value ?? last;
      if (last.hasRoot && last.nodeCount > 0) return last;
      if (Date.now() - start > timeoutMs) return last;
      await sleep(1000);
    }
  }

  /**
   * Simulates a user action by sending a message to the host through the REAL
   * webview bridge — the same `window.vscode.postMessage` the React app uses.
   * Reached via the same-origin `active-frame.contentWindow`. Returns `'sent'`
   * when the bridge was found and the message dispatched.
   */
  async postBridgeMessage(webviewSession: string, msg: unknown): Promise<string> {
    const json = JSON.stringify(msg);
    const expression = `(() => {
      const f = document.getElementById('active-frame');
      const w = f && f.contentWindow;
      if (w && w.vscode && typeof w.vscode.postMessage === 'function') { w.vscode.postMessage(${json}); return 'sent'; }
      return 'no-bridge';
    })()`;
    const ev = await this.send('Runtime.evaluate', { expression, returnByValue: true }, webviewSession);
    return ev.result?.value ?? 'unknown';
  }

  /** Webview console.error + uncaught exceptions captured since connect. */
  getConsoleErrors(): string[] {
    return [...this.consoleErrors];
  }

  close(): void {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}
