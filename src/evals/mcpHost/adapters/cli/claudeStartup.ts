import { StringDecoder } from 'node:string_decoder';
import type { HostDiagnostics } from '../../../../types/hostDiagnostics.js';

const MAX_STARTUP_BYTES = 4 * 1024 * 1024;
type Startup = NonNullable<HostDiagnostics['claudeStartup']>;

/** Observe Claude's own registration, not a separate tools/list connection. */
export class ClaudeStartup {
  private readonly startedAt = Date.now();
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  private bytes = 0;
  private result?: Startup;

  constructor(private readonly expectedServers: string[]) {}

  get diagnostics(): HostDiagnostics {
    return {
      claudeStartup: this.result ?? {
        status: 'missing',
        elapsedMs: Date.now() - this.startedAt,
        servers: this.expectedServers.map((name) => ({
          name,
          status: 'unknown',
          tools: [],
        })),
      },
    };
  }

  get error(): string | undefined {
    return this.result?.status === 'ready'
      ? undefined
      : 'MCP connection failed: Claude did not initialize every configured server.';
  }

  /** Return an infrastructure error as soon as startup is known to be invalid. */
  push(chunk: Buffer): string | undefined {
    if (this.result) return this.error;
    this.bytes += chunk.length;
    if (this.bytes > MAX_STARTUP_BYTES)
      return 'MCP connection failed: Claude startup output exceeded its limit.';
    this.pending += this.decoder.write(chunk);
    let newline: number;
    while ((newline = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      let event: Record<string, unknown>;
      try {
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== 'object' || Array.isArray(value))
          continue;
        event = value as Record<string, unknown>;
      } catch {
        continue;
      }
      if (event.type === 'system' && event.subtype === 'init') {
        const servers = Array.isArray(event.mcp_servers)
          ? event.mcp_servers
          : [];
        const tools = Array.isArray(event.tools)
          ? event.tools.filter(
              (tool): tool is string =>
                typeof tool === 'string' && /^[\w.-]{1,512}$/.test(tool)
            )
          : [];
        const catalogs: Startup['servers'] = this.expectedServers.map(
          (name) => {
            const server = servers.find(
              (entry: unknown) =>
                entry !== null &&
                typeof entry === 'object' &&
                'name' in entry &&
                entry.name === name
            ) as Record<string, unknown> | undefined;
            const status = server?.status;
            const prefix = `mcp__${name.replace(/[^a-zA-Z0-9_-]/g, '_')}__`;
            return {
              name,
              status:
                status === 'connected' ||
                status === 'pending' ||
                status === 'failed' ||
                status === 'needs-auth' ||
                status === 'disabled'
                  ? status
                  : 'unknown',
              tools: [
                ...new Set(tools.filter((tool) => tool.startsWith(prefix))),
              ].sort(),
            };
          }
        );
        this.result = {
          status:
            Array.isArray(event.tools) &&
            Array.isArray(event.mcp_servers) &&
            catalogs.every((server) => server.status === 'connected')
              ? 'ready'
              : 'failed',
          elapsedMs: Date.now() - this.startedAt,
          servers: catalogs,
          ...(typeof event.model === 'string' &&
          /^[\w.:/-]{1,128}$/.test(event.model)
            ? { model: event.model }
            : {}),
          ...(typeof event.claude_code_version === 'string' &&
          /^[\w.+-]{1,64}$/.test(event.claude_code_version)
            ? { version: event.claude_code_version }
            : {}),
        };
        this.pending = '';
        return this.error;
      }
      if (event.type === 'assistant' || event.type === 'result')
        return this.error;
    }
    return undefined;
  }
}
