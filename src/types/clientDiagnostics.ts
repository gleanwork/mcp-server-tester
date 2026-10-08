/** Sanitized client evidence, not an evaluation score or raw process log. */
export interface ClientDiagnostics {
  /**
   * Why the client produced no usable trace. `not-submitted`: the client never
   * ran the case (its batch stopped, or failed before the case's turn).
   * `cleanup`: the case ran, but restoring the desktop afterwards failed, so
   * its state (and the case's isolation) is unknown.
   */
  failureKind?:
    | 'startup'
    | 'timeout'
    | 'process'
    | 'output'
    | 'not-submitted'
    | 'cleanup';
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
