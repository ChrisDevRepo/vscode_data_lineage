import { createRoot } from 'react-dom/client';
import './index.css';

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
      <ErrorBoundary>
        <DetailApp />
      </ErrorBoundary>
    );
  });
} else {
    Promise.all([
    import('./components/App'),
    import('./contexts/VsCodeContext'),
    import('./components/ErrorBoundary'),
  ]).then(([{ App }, { VsCodeProvider }, { ErrorBoundary }]) => {
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

    createRoot(root).render(
      <ErrorBoundary>
        <VsCodeProvider api={vscodeApi}>
          <App />
        </VsCodeProvider>
      </ErrorBoundary>
    );
  });
}
