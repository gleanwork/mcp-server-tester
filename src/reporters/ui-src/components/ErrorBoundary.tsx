import React from 'react';

interface Props {
  children: React.ReactNode;
  label?: string;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="p-6 text-sm text-destructive">
          <p className="font-medium">
            Something went wrong in {this.props.label ?? 'this section'}.
          </p>
          <p className="mt-1 text-muted-foreground font-mono text-xs">
            {this.state.error?.message}
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}
