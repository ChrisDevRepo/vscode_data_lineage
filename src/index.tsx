import { createRoot } from 'react-dom/client';
import { App } from './components/App';
import { VsCodeProvider } from './contexts/VsCodeContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

// Acquire VS Code API ONCE — this is the only place it should be called
const vscodeApi = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
window.vscode = vscodeApi ?? undefined; // Used by ErrorBoundary (class component, can't use context)

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
