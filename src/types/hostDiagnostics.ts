/** Sanitized host evidence, not an evaluation verdict or raw process log. */
export interface HostDiagnostics {
  failureKind?: 'startup' | 'timeout' | 'process' | 'output';
  claudeStartup?: {
    status: 'ready' | 'failed' | 'missing';
    elapsedMs: number;
    model?: string;
    version?: string;
    servers: Array<{
      name: string;
      status:
        | 'connected'
        | 'pending'
        | 'failed'
        | 'needs-auth'
        | 'disabled'
        | 'unknown';
      tools: string[];
    }>;
  };
}
