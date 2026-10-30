import { Component, type ReactNode, type ErrorInfo } from 'react';

interface ErrorBoundaryProps {
  /** The child components to be rendered and monitored for errors. */
  children: ReactNode;
  /** Optional custom fallback UI to display when an error occurs. */
  fallback?:
    | ReactNode
    | ((args: { error: Error | null; reset: () => void }) => ReactNode);
  /** Optional callback triggered when an error is caught. */
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  /** Changes when the guarded surface should retry after a previous render failure. */
  resetKey?: string;
  /** Structured diagnostic context sent to the extension Output channel. */
  context?: Record<string, unknown>;
}

/** State for the {@link ErrorBoundary} component. */
interface ErrorBoundaryState {
  /** Indicates if an error has occurred within the child component tree. */
  hasError: boolean;
  /** The error object captured from the failing component. */
  error: Error | null;
  resetKey?: string;
}

/** A standard React Error Boundary that captures runtime errors in the component tree. */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, resetKey: props.resetKey };
  }

  /** Updates state so the next render will show the fallback UI. */
  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  /** Clears a captured error when the caller changes the reset key. */
  static getDerivedStateFromProps(
    props: ErrorBoundaryProps,
    state: ErrorBoundaryState,
  ): Partial<ErrorBoundaryState> | null {
    if (state.hasError && props.resetKey !== state.resetKey) {
      return { hasError: false, error: null, resetKey: props.resetKey };
    }
    if (props.resetKey !== state.resetKey) {
      return { resetKey: props.resetKey };
    }
    return null;
  }

  /** Performs side effects when an error is caught, such as logging. */
  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    const vscodeApi = window.vscode;
    if (vscodeApi && typeof vscodeApi.postMessage === 'function') {
      vscodeApi.postMessage({
        type: 'error',
        source: 'error-boundary',
        error: error.message,
        stack: error.stack,
        componentStack: errorInfo.componentStack ?? undefined,
        context: this.props.context,
        timestamp: Date.now(),
      });
    }

    this.props.onError?.(error, errorInfo);
  }

  /** Renders the children or the fallback UI if an error occurred. */
  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        if (typeof this.props.fallback === 'function') {
          return this.props.fallback({
            error: this.state.error,
            reset: () =>
              this.setState({
                hasError: false,
                error: null,
                resetKey: this.props.resetKey,
              }),
          });
        }
        return this.props.fallback;
      }

      return (
        <div className="px-4 py-3 text-xs ln-text-muted">
          Something went wrong. Click a node again to reload.
        </div>
      );
    }

    return this.props.children;
  }
}
