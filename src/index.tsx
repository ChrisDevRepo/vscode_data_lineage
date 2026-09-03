import { createRoot } from 'react-dom/client';
import './index.css';
import { notifyUser } from './utils/notify';

const root = document.getElementById('root');
if (!root) {
  throw new Error('Root element not found!');
}

/**
 * Reports a failed bootstrap chunk load and leaves a visible message in place of the panel.
 *
 * @remarks
 * The dynamic imports below carry the ErrorBoundary and — in detail mode — the global
 * `unhandledrejection` listener itself, so a chunk that fails to load has no other reporter: without
 * this the panel is blank and nothing reaches the Output channel. `window.vscode` may legitimately
 * be undefined here (detail mode acquires it inside the chunk that just failed), in which case the
 * in-page message is the only surface left.
 *
 * @param surface - Which webview failed, used to label the Output-channel record.
 * @param mount - Element the failure message replaces the panel content in.
 * @param error - The rejection value from the import chain.
 */
function reportBootstrapFailure(surface: 'detail' | 'panel', mount: HTMLElement, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  window.vscode?.postMessage({
    type: 'error',
    source: 'window-error',
    error: `${surface} webview failed to load: ${message}`,
    stack: error instanceof Error ? error.stack : undefined,
    timestamp: Date.now(),
  });
  // textContent, never innerHTML: `message` is provider/runtime text and must not be parsed as markup.
  mount.textContent = 'Data Lineage could not load this view. Reload the window; if it persists, reinstall the extension.';
  mount.style.setProperty('padding', '12px');
  mount.style.setProperty('font-size', '12px');
  mount.style.setProperty('color', 'var(--vscode-errorForeground)');
}

if ((window as unknown as { __DETAIL_MODE__?: boolean }).__DETAIL_MODE__) {
    // Global error handlers + ErrorBoundary are set up in DetailApp.tsx module scope
  // (window.vscode is also set there, which ErrorBoundary requires).
  Promise.all([
    import('./detail/DetailApp'),
    import('./components/ErrorBoundary'),
  ]).then(([{ DetailApp }, { ErrorBoundary }]) => {
    createRoot(root).render(
      <ErrorBoundary
        onError={() => {
          // Crash is already logged by ErrorBoundary.componentDidCatch; surface it to the
          // user before recovery so a real crash is never a silent flicker.
          notifyUser('The detail panel hit an error and was closed — see the output channel for details.');
          // Close it via the existing 'close-detail' bridge message.
          // 800 ms delay lets the fallback render before disposal.
          setTimeout(() => window.vscode?.postMessage({ type: 'close-detail' }), 800);
        }}
        fallback={
          <div className="px-4 py-3 text-xs" style={{ color: 'var(--vscode-descriptionForeground)' }}>
            Detail panel encountered an error — closing…
          </div>
        }
      >
        <DetailApp />
      </ErrorBoundary>
    );
  }).catch(err => reportBootstrapFailure('detail', root, err));
} else {
    // Acquire VS Code API ONCE — this is the only place it should be called
    const vscodeApi = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
    window.vscode = vscodeApi ?? undefined; // Used by ErrorBoundary (class component, can't use context)

    // Global error handlers — surface silent failures in Debug Console + outputChannel
    window.addEventListener('unhandledrejection', (event) => {
      const isErr = event.reason instanceof Error;
      const msg = isErr ? event.reason.message : String(event.reason);
      const stack = isErr ? event.reason.stack : undefined;
      window.vscode?.postMessage({
        type: 'error',
        source: 'unhandled-rejection',
        error: msg,
        stack,
        timestamp: Date.now(),
      });
    });

    window.addEventListener('error', (event) => {
      // A browser notice — a ResizeObserver loop report, a failed resource load — arrives as an
      // error event with nothing thrown behind it. Reporting it as an application failure spends a
      // modal toast on something the user cannot act on, so it goes to the log instead.
      if (!(event.error instanceof Error)) {
        window.vscode?.postMessage({ type: 'log', level: 'debug', text: `[Graph] Window notice: ${event.message}` });
        return;
      }
      window.vscode?.postMessage({
        type: 'error',
        source: 'window-error',
        error: event.message,
        stack: event.error.stack,
        timestamp: Date.now(),
      });
    });

    Promise.all([
    import('./components/App'),
    import('./contexts/VsCodeContext'),
    import('./components/ErrorBoundary'),
    import('./engine/graphBuilder'),
  ]).then(([{ App }, { VsCodeProvider }, { ErrorBoundary }, { setGraphLogSink }]) => {
    // The engine has no bridge of its own and the detail webview builds no graphs, so this is the
    // one place the sink is installed — here, before the first render can build one.
    setGraphLogSink((level, text) => window.vscode?.postMessage({ type: 'log', level, text }));

    createRoot(root).render(
      <ErrorBoundary
        onError={() => {
          // The error toast + detailed Output log are emitted by ErrorBoundary.componentDidCatch
          // → bridge 'error' handler (error level). Here we only auto-reopen the panel.
          // 800 ms delay lets the fallback render before the panel is recycled.
          setTimeout(() => window.vscode?.postMessage({ type: 'reload' }), 800);
        }}
        fallback={
          <div className="px-4 py-3 text-xs" style={{ color: 'var(--vscode-descriptionForeground)' }}>
            App encountered an error — recovering…
          </div>
        }
      >
        <VsCodeProvider api={vscodeApi}>
          <App />
        </VsCodeProvider>
      </ErrorBoundary>
    );
  }).catch(err => reportBootstrapFailure('panel', root, err));
}
