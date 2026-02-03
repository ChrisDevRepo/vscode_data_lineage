import { Component, ReactNode, ErrorInfo } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Send error to extension host for OutputChannel logging
    const vscodeApi = (window as any).vscode;
    if (vscodeApi && typeof vscodeApi.postMessage === 'function') {
      vscodeApi.postMessage({
        type: 'error',
        error: error.message,
        stack: error.stack,
        componentStack: errorInfo.componentStack,
        timestamp: Date.now()
      });
    }

    // Call custom error handler if provided
    this.props.onError?.(error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div style={{
          padding: '20px',
          margin: '20px',
          border: '2px solid #ff4444',
          borderRadius: '8px',
          backgroundColor: '#2d2d2d',
          color: '#ffffff',
          fontFamily: 'monospace'
        }}>
          <h2 style={{ color: '#ff4444', marginTop: 0 }}>⚠️ React Error</h2>
          <p style={{ color: '#cccccc' }}>Something went wrong in the application.</p>
          {this.state.error && (
            <details style={{ marginTop: '10px' }}>
              <summary style={{ cursor: 'pointer', color: '#569cd6' }}>
                Error Details
              </summary>
              <pre style={{
                marginTop: '10px',
                padding: '10px',
                backgroundColor: '#1e1e1e',
                borderRadius: '4px',
                overflow: 'auto',
                fontSize: '12px',
                color: '#d4d4d4'
              }}>
                {this.state.error.message}
                {'\n\n'}
                {this.state.error.stack}
              </pre>
            </details>
          )}
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: '15px',
              padding: '8px 16px',
              backgroundColor: '#007acc',
              color: '#ffffff',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '14px'
            }}
          >
            Reload Extension
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
