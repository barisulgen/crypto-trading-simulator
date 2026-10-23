import { Component, type ErrorInfo, type ReactNode } from 'react';

export const FALLBACK_TEXT = 'Something went wrong displaying this screen';

/** Keeps a render error from unmounting the whole app into a blank page: shows a message and a Reload button. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-fg">
        <p>{FALLBACK_TEXT}</p>
        <button
          type="button"
          className="rounded-ctl border border-border px-3 py-1.5 text-sm"
          onClick={() => window.location.reload()}
        >
          Reload
        </button>
      </div>
    );
  }
}
