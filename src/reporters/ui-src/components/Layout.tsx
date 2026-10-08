import React from 'react';
import { Logo } from './Logo';
import { DarkModeToggle } from './DarkModeToggle';

/** The page frame: the product name and the dark mode toggle. The run's own header says when and what. */
export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col bg-background">
      <div className="flex h-14 items-center justify-between border-b bg-card">
        <div className="max-w-[1600px] mx-auto w-full px-6 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Logo size={22} className="text-foreground" />
            <span className="text-lg font-bold">MCP Server Tester</span>
          </div>
          <DarkModeToggle />
        </div>
      </div>
      <main className="flex-1 overflow-hidden">{children}</main>
    </div>
  );
}
