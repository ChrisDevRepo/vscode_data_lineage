import { createRoot } from 'react-dom/client';
import './index.css';
import { notifyUser } from './utils/notify';

const root = document.getElementById('root');
if (!root) {
  throw new Error('Root element not found!');
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
  });
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
      window.vscode?.postMessage({
        type: 'error',
        source: 'window-error',
        error: event.message,
        stack: event.error instanceof Error ? event.error.stack : undefined,
        timestamp: Date.now(),
      });
    });

    Promise.all([
    import('./components/App'),
    import('./contexts/VsCodeContext'),
    import('./components/ErrorBoundary'),
  ]).then(([{ App }, { VsCodeProvider }, { ErrorBoundary }]) => {

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
  });
}
