import React, { Component, type ReactNode, type ErrorInfo } from 'react';

/**
 * Props for the {@link ErrorBoundary} component.
 */
interface ErrorBoundaryProps {
  /** The child components to be rendered and monitored for errors. */
  children: ReactNode;
  /** Optional custom fallback UI to display when an error occurs. */
  fallback?: ReactNode;
  /** Optional callback triggered when an error is caught. */
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

/**
 * State for the {@link ErrorBoundary} component.
 */
interface ErrorBoundaryState {
  /** Indicates if an error has occurred within the child component tree. */
  hasError: boolean;
  /** The error object captured from the failing component. */
  error: Error | null;
}

/**
 * A standard React Error Boundary that captures runtime errors in the component tree.
 *
 * @remarks
 * This class component implements `getDerivedStateFromError` and `componentDidCatch`.
 * When an error occurs, it:
 * 1. Updates state to trigger a fallback UI.
 * 2. Logs the error to the VS Code Extension Host via `postMessage`.
 * 3. Executes the optional `onError` callback.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  /**
   * Updates state so the next render will show the fallback UI.
   *
   * @param error - The error that was thrown.
   * @returns The updated state object.
   */
  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  /**
   * Performs side effects when an error is caught, such as logging.
   *
   * @param error - The error that was thrown.
   * @param errorInfo - Information about the component stack during the error.
   */
  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Send error to extension host for OutputChannel logging
    const vscodeApi = window.vscode;
    if (vscodeApi && typeof vscodeApi.postMessage === 'function') {
      vscodeApi.postMessage({
        type: 'error',
        source: 'error-boundary',
        error: error.message,
        stack: error.stack,
        componentStack: errorInfo.componentStack ?? undefined,
        timestamp: Date.now()
      });
    }

    // Call custom error handler if provided
    this.props.onError?.(error, errorInfo);
  }

  /**
   * Renders the children or the fallback UI if an error occurred.
   *
   * @returns The rendered React node.
   */
  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
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
