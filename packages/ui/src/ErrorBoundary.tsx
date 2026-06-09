import { Component, type ErrorInfo, type ReactNode } from 'react';

export interface ErrorBoundaryFallbackProps {
  error: Error;
  /** Clear the error and re-render the boundary's children. */
  reset: () => void;
}

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Render the fallback UI shown when a child throws during render. */
  fallback: (props: ErrorBoundaryFallbackProps) => ReactNode;
  /**
   * When any value in this array changes, the boundary clears its error and
   * retries. Pass the route key (e.g. location.pathname) so navigating away
   * from a broken page recovers automatically.
   */
  resetKeys?: unknown[];
  /** Optional hook for logging/telemetry. */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface State {
  error: Error | null;
}

function changed(a: unknown[] = [], b: unknown[] = []): boolean {
  return a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));
}

/**
 * Generic render-error boundary. UI-agnostic: callers supply the fallback so
 * the portals can render translated, on-brand recovery UI. Catches errors
 * thrown during render of its subtree (not async/event errors — those should
 * surface via react-query `isError` + toasts).
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  override componentDidUpdate(prev: ErrorBoundaryProps): void {
    if (this.state.error && changed(prev.resetKeys, this.props.resetKeys)) {
      this.reset();
    }
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    if (this.state.error) {
      return this.props.fallback({ error: this.state.error, reset: this.reset });
    }
    return this.props.children;
  }
}
