import { createRoot } from 'react-dom/client';
import { App } from './components/App';
import { VsCodeProvider } from './contexts/VsCodeContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

// Acquire VS Code API ONCE — this is the only place it should be called
const vscodeApi = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
window.vscode = vscodeApi ?? undefined; // Used by ErrorBoundary (class component, can't use context)

// Global error handlers — surface silent failures in Debug Console + outputChannel
window.addEventListener('unhandledrejection', (event) => {
  const msg = event.reason instanceof Error ? event.reason.message : String(event.reason);
  console.error('[Webview] Unhandled rejection:', msg);
  window.vscode?.postMessage({ type: 'error', error: `Unhandled rejection: ${msg}` });
});

window.addEventListener('error', (event) => {
  console.error('[Webview] Uncaught error:', event.message);
  window.vscode?.postMessage({ type: 'error', error: `Uncaught error: ${event.message}` });
});

const root = document.getElementById('root');
if (!root) {
  throw new Error('Root element not found!');
}

createRoot(root).render(
  <ErrorBoundary>
    <VsCodeProvider api={vscodeApi}>
      <App />
    </VsCodeProvider>
  </ErrorBoundary>
);
