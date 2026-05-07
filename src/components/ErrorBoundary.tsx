import { Component, type ErrorInfo, type ReactNode } from 'react';
import { appendAudit } from '../lib/fs/audit';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Top-level error boundary. Catches synchronous render errors anywhere in the
 * tree, logs to the OPFS audit log, and shows a recoverable fallback. Async
 * errors (worker failures, fetch errors) are still surfaced via the store's
 * pushError() flow.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    void appendAudit({
      kind: 'app-error',
      message: error.message,
      details: { stack: error.stack ?? null, componentStack: info.componentStack ?? null },
    });
  }

  private handleReload = (): void => {
    location.reload();
  };

  private handleDismiss = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div
        role="alert"
        className="flex h-full w-full items-center justify-center bg-slate-50 p-4"
      >
        <div className="max-w-md space-y-3 rounded-lg border border-red-200 bg-white p-4 shadow-sm">
          <div className="text-sm font-semibold text-red-700">Something went wrong</div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-red-50 p-2 text-xs text-red-700">
            {this.state.error.message}
          </pre>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={this.handleDismiss}
              className="rounded border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Dismiss
            </button>
            <button
              type="button"
              onClick={this.handleReload}
              className="rounded bg-tamias-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
            >
              Reload app
            </button>
          </div>
          <p className="text-[11px] text-slate-500">
            The error was recorded in the local audit log. No data was sent off your device.
          </p>
        </div>
      </div>
    );
  }
}
