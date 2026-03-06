import React from 'react';
import { Logo } from './Logo';
import { DarkModeToggle } from './DarkModeToggle';

interface LayoutProps {
  timestamp: string;
  platform: string;
  durationMs: number;
  ci?: boolean;
  children: React.ReactNode;
}

export function Layout({
  timestamp,
  platform,
  durationMs,
  ci,
  children,
}: LayoutProps) {
  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Header */}
      <div className="flex h-16 items-center justify-between border-b bg-card">
        <div className="max-w-[1600px] mx-auto w-full px-6 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Logo size={24} className="text-foreground" />
            <h1 className="text-xl font-bold">MCP Server Tester</h1>
          </div>
          <div className="flex items-center gap-6">
            <div className="flex flex-col text-right">
              <div className="flex items-center justify-end gap-2">
                <span className="text-sm font-semibold">
                  {new Date(timestamp).toLocaleString()}
                </span>
                {ci && (
                  <span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
                    CI
                  </span>
                )}
              </div>
              <span className="text-xs text-muted-foreground">
                {(durationMs / 1000).toFixed(1)}s · {platform}
              </span>
            </div>
            <DarkModeToggle />
          </div>
        </div>
      </div>

      {/* Page content */}
      <main className="flex-1 overflow-hidden">{children}</main>
    </div>
  );
}
