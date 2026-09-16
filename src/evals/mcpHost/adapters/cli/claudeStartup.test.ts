import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeStartup } from './claudeStartup.js';
import { runCLIHost } from './runner.js';
import { registerBuiltinHosts } from '../../../builtinHosts.js';
import { getHost } from '../../../frameworkRegistries.js';
import { hostTraceToExecution } from '../../../hostTrace.js';
import { runEvalDataset } from '../../../evalRunner.js';
import type { MCPFixtureApi } from '../../../../mcp/fixtures/mcpFixture.js';

const init = {
  type: 'system',
  subtype: 'init',
  model: 'claude-sonnet-4-6',
  claude_code_version: '2.1.195',
  mcp_servers: [{ name: 'glean', status: 'connected' }],
  tools: ['Bash', 'ToolSearch', 'mcp__glean__search'],
};
function line(event: unknown): string {
  return `${JSON.stringify(event)}\n`;
}
let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-startup-'));
  registerBuiltinHosts();
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

function script(body: string): string {
  const file = path.join(directory, 'claude');
  fs.writeFileSync(file, `#!${process.execPath}\n${body}`, { mode: 0o700 });
  return file;
}

function host(body: string, timeout = 1500) {
  script(body);
  return getHost('claude-cli').run!(
    {
      scenario: 'unchanged scenario',
      servers: [
        {
          label: 'glean',
          transport: 'http',
          serverUrl: 'https://mcp.invalid',
          auth: { accessToken: 'credential-canary' },
        },
      ],
      env: {
        PATH: directory,
        ENABLE_TOOL_SEARCH: 'true',
        MCP_CONNECTION_NONBLOCKING: 'true',
      },
    },
    { type: 'claude-cli', timeout },
    { manifest: { name: 'offline', datasets: [] } }
  );
}

describe('Claude Code MCP startup', () => {
  it('keeps dotted tool names and rejects an unproven catalog shape', () => {
    const valid = new ClaudeStartup(['glean']);
    expect(
      valid.push(
        Buffer.from(
          line({ ...init, tools: ['mcp__glean__github.search_code'] })
        )
      )
    ).toBeUndefined();
    expect(valid.diagnostics.claudeStartup?.servers[0]?.tools).toEqual([
      'mcp__glean__github.search_code',
    ]);
    const invalid = new ClaudeStartup(['glean']);
    expect(invalid.push(Buffer.from(line({ ...init, tools: null })))).toContain(
      'MCP connection failed'
    );
    expect(invalid.diagnostics.claudeStartup?.status).toBe('failed');
  });

  it.skipIf(process.platform === 'win32')(
    'stops owned descendants even when they ignore SIGTERM and hold pipes open',
    async () => {
      const marker = path.join(directory, 'descendant.txt');
      const pidFile = path.join(directory, 'descendant.pid');
      const descendant = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x'), 20);`;
      try {
        const result = await host(
          `console.log(${JSON.stringify(line(init))}); require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'inherit' }); setInterval(() => {}, 1000);`,
          800
        );
        expect(result.error).toContain('timed out');
        const before = fs.readFileSync(marker, 'utf8');
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(fs.readFileSync(marker, 'utf8')).toBe(before);
      } finally {
        if (fs.existsSync(pidFile)) {
          try {
            process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL');
          } catch (error) {
            expect((error as NodeJS.ErrnoException).code).toBe('ESRCH');
          }
        }
      }
    }
  );

  it('retains failed startup evidence through the legacy dataset runner', async () => {
    const command = script(
      `console.log(${JSON.stringify(line({ ...init, mcp_servers: [] }))});`
    );
    const result = await runEvalDataset(
      {
        dataset: {
          name: 'legacy',
          cases: [
            {
              id: 'case',
              mode: 'mcp_host',
              scenario: 'scenario',
              mcpHostConfig: {
                hostType: 'cli',
                cli: { command, args: [], claudeMcpServers: ['glean'] },
              },
            },
          ],
        },
      },
      { mcp: { authType: 'none' } as MCPFixtureApi }
    );
    expect(result.caseResults[0]?.pass).toBe(false);
    expect(result.caseResults[0]?.hostDiagnostics).toMatchObject({
      failureKind: 'startup',
      claudeStartup: { status: 'failed' },
    });
  });

  it('retains separate diagnostics and infrastructure classification for every iteration', async () => {
    let attempt = 0;
    const result = await runEvalDataset(
      {
        dataset: {
          name: 'startup',
          cases: [
            { id: 'case', mode: 'host', scenario: 'scenario', iterations: 2 },
          ],
        },
        executeCase: async () => {
          const event = attempt++ === 0 ? { ...init, mcp_servers: [] } : init;
          return hostTraceToExecution(
            await host(
              `console.log(${JSON.stringify(line(event))}); console.log(JSON.stringify({type:'result',result:'answer'}));`
            ),
            'structured'
          );
        },
      },
      {}
    );
    const row = result.caseResults[0]!;
    expect(row.infrastructureErrorCount).toBe(1);
    expect(row.assertionPassRate).toBe(1);
    expect(
      row.iterationResults?.map((r) => r.hostDiagnostics?.claudeStartup?.status)
    ).toEqual(['failed', 'ready']);
    expect(row.iterationResults?.[0]?.hostDiagnostics?.failureKind).toBe(
      'startup'
    );
  });

  it('retains only bounded metadata from a chunked init event', () => {
    const observer = new ClaudeStartup(['glean']);
    const stream = Buffer.from(
      line({ ...init, token: 'credential-canary', message: 'private scenario' })
    );
    for (let i = 0; i < stream.length; i += 7)
      expect(observer.push(stream.subarray(i, i + 7))).toBeUndefined();
    expect(observer.diagnostics.claudeStartup).toMatchObject({
      status: 'ready',
      model: init.model,
      version: init.claude_code_version,
      servers: [
        { name: 'glean', status: 'connected', tools: ['mcp__glean__search'] },
      ],
    });
    expect(JSON.stringify(observer.diagnostics)).not.toMatch(
      /credential-canary|private scenario|Bash|ToolSearch/
    );
  });

  it.each(['pending', 'failed', 'needs-auth', 'disabled'])(
    'rejects %s servers before evaluating the answer',
    async (status) => {
      const result = await host(
        `console.log(${JSON.stringify(line({ ...init, mcp_servers: [{ name: 'glean', status }] }))}); setInterval(() => {}, 1000);`
      );
      expect(result.error).toContain('MCP connection failed');
      expect(result.diagnostics?.claudeStartup?.status).toBe('failed');
      expect(hostTraceToExecution(result, 'structured').response).toMatchObject(
        { success: false, diagnostics: { claudeStartup: { status: 'failed' } } }
      );
      expect(JSON.stringify(result)).not.toContain('credential-canary');
    }
  );

  it('reports an empty catalog without rejecting legitimate resource-only servers', () => {
    const observer = new ClaudeStartup(['glean', 'jira']);
    expect(
      observer.push(
        Buffer.from(
          line({
            ...init,
            mcp_servers: [
              ...init.mcp_servers,
              { name: 'jira', status: 'connected' },
            ],
          })
        )
      )
    ).toBeUndefined();
    expect(observer.diagnostics.claudeStartup?.status).toBe('ready');
    expect(observer.diagnostics.claudeStartup?.servers[1]?.tools).toEqual([]);
  });

  it('does not treat an empty stream or an unproven no-tools answer as success', async () => {
    for (const body of [
      '',
      'console.log(JSON.stringify({type:"result",result:"No access"}));',
    ]) {
      const result = await host(body);
      expect(result.error).toContain('MCP connection failed');
      expect(result.diagnostics?.claudeStartup?.status).toBe('missing');
    }
  });

  it('enforces blocking startup without changing tool search or the prompt', async () => {
    const result = await host(`
const assert = require('node:assert/strict');
assert.equal(process.env.MCP_CONNECTION_NONBLOCKING, 'false');
assert.equal(process.env.MCP_CONNECT_TIMEOUT_MS, '30000');
assert.equal(process.env.ENABLE_TOOL_SEARCH, 'true');
assert.equal(process.argv[process.argv.indexOf('-p') + 1], 'unchanged scenario');
setTimeout(() => { console.log(${JSON.stringify(line(init))}); console.log(JSON.stringify({ type: 'result', result: 'answer', usage: { input_tokens: 4, output_tokens: 2 } })); }, 100);
`);
    expect(result.error).toBeUndefined();
    expect(result.finalText).toBe('answer');
    expect(result.usage?.inputTokens).toBe(4);
    expect(result.diagnostics?.claudeStartup?.status).toBe('ready');
  });

  it('retains the partial trace and startup evidence at the enclosing host deadline', async () => {
    const result = await host(
      `
console.log(${JSON.stringify(line(init))});
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call1', name: 'mcp__glean__search', input: { query: 'sample' } }] } }));
setInterval(() => {}, 1000);
`,
      350
    );
    expect(result.error).toContain('timed out');
    expect(result.events).toMatchObject([
      { name: 'search', source: 'mcp', server: 'glean' },
    ]);
    expect(result.diagnostics?.claudeStartup?.status).toBe('ready');
    expect(result.usage).toBeUndefined();
  });

  it('retains evidence on nonzero exit without persisting raw stderr', async () => {
    const result = await host(
      `console.log(${JSON.stringify(line(init))}); console.error('credential-canary'); process.exitCode = 7;`
    );
    expect(result.error).toContain('exit code 7');
    expect(result.diagnostics?.claudeStartup?.status).toBe('ready');
    expect(JSON.stringify(result)).not.toContain('credential-canary');
  });

  it('does not impose the Claude startup protocol on generic CLI hosts', async () => {
    const result = await runCLIHost(
      {
        command: script(
          'console.log(JSON.stringify({type:"result",result:"generic"}));'
        ),
        args: [],
      },
      'test'
    );
    expect(result.success).toBe(true);
    expect(result.response).toBe('generic');
    expect(result.diagnostics).toBeUndefined();
  });
});
