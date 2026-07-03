import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** Top-level error boundary that prevents a render error from blanking the app. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('Unhandled UI error:', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="grid min-h-screen place-items-center px-6 text-center">
          <div className="max-w-md space-y-4">
            <h1 className="text-2xl font-bold">Something went wrong</h1>
            <p className="text-sm text-muted-foreground">
              An unexpected error occurred while rendering the app.
            </p>
            <pre className="overflow-x-auto rounded-lg bg-white/[0.03] p-3 text-left text-xs text-destructive scrollbar-thin">
              {this.state.error.message}
            </pre>
            <Button onClick={() => window.location.reload()}>Reload app</Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
