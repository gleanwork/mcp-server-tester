import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  closeMCPClient,
  createMCPClientForConfig,
} from '../mcp/clientFactory.js';
import { createMCPFixture } from '../mcp/fixtures/mcpFixture.js';
import { runConformanceChecks } from './conformanceChecks.js';
import type { MCPConformanceResult } from './conformanceChecks.js';

/**
 * Integration tests for the 2026-07-28 conformance checks against a scripted
 * HTTP server (tests/mocks/rawModernServer.mjs). Each fault switches on one
 * spec violation; the matching check must catch it, and a clean server must
 * pass every check with no warnings.
 */
const serverScript = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../tests/mocks/rawModernServer.mjs'
);

const running: ChildProcess[] = [];

/** Starts the scripted server on a free port and returns its URL. */
async function startServer(faults: string[]): Promise<string> {
  const child = spawn(process.execPath, [serverScript, '0'], {
    env: { ...process.env, FAULTS: faults.join(',') },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  running.push(child);
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('raw modern server did not start')),
      10_000
    );
    child.stderr.on('data', (chunk: Buffer) => {
      const url = /raw modern server on (\S+)/.exec(chunk.toString())?.[1];
      if (url) {
        clearTimeout(timer);
        resolve(url);
      }
    });
  });
}

async function checkServer(
  faults: string[] = []
): Promise<MCPConformanceResult> {
  const serverUrl = await startServer(faults);
  const client = await createMCPClientForConfig({
    transport: 'http',
    serverUrl,
    protocol: '2026-07-28',
  });
  try {
    return await runConformanceChecks(createMCPFixture(client));
  } finally {
    await closeMCPClient(client);
  }
}

function check(result: MCPConformanceResult, name: string) {
  const found = result.checks.find((c) => c.name === name);
  if (!found) throw new Error(`check ${name} not reported`);
  return found;
}

afterEach(() => {
  for (const child of running.splice(0)) child.kill();
});

describe('modern-era conformance checks', () => {
  it('a conformant server passes every check with no warnings', async () => {
    const result = await checkServer();
    const notPassing = result.checks.filter((c) => !c.pass);
    expect(notPassing).toEqual([]);
    expect(result.pass).toBe(true);
    expect(result.protocol.era).toBe('modern');
    expect(check(result, 'unsupported_version_rejected').skipped).toBeFalsy();
    expect(check(result, 'missing_meta_rejected').skipped).toBeFalsy();
  }, 30_000);

  it.each([
    ['no-ttl', 'cache_hints_present', 'must'],
    ['no-result-type', 'result_type_present', 'must'],
    ['no-server-info', 'result_server_info', 'should'],
    ['no-server-info', 'discover_server_info', 'should'],
    ['accept-bad-version', 'unsupported_version_rejected', 'must'],
    ['accept-missing-meta', 'missing_meta_rejected', 'must'],
    ['ignore-header-mismatch', 'header_mismatch_rejected', 'must'],
    ['unknown-method-200', 'unknown_method_not_found', 'must'],
    ['mint-session', 'no_session_id', 'should'],
    ['not-found-32002', 'resource_not_found_error', 'must'],
    ['not-found-32002', 'reserved_error_codes', 'must'],
    ['empty-not-found', 'resource_not_found_error', 'must'],
    ['unknown-tool-iserror', 'unknown_tool_protocol_error', 'should'],
    ['reserved-code', 'reserved_error_codes', 'must'],
    ['shuffle-tools', 'tools_list_deterministic', 'should'],
  ] as const)(
    'fault %s fails %s (%s)',
    async (fault, name, severity) => {
      const result = await checkServer([fault]);
      const failed = check(result, name);
      expect(failed.pass).toBe(false);
      expect(failed.skipped).toBeFalsy();
      expect(failed.severity).toBe(severity);
      expect(failed.specVersion).toBe('2026-07-28');
      // Only 'must' failures fail the overall result.
      expect(result.pass).toBe(severity === 'should');
    },
    30_000
  );

  it('skips probe checks when probes are disabled', async () => {
    const serverUrl = await startServer([]);
    const client = await createMCPClientForConfig({
      transport: 'http',
      serverUrl,
      protocol: '2026-07-28',
    });
    try {
      const result = await runConformanceChecks(createMCPFixture(client), {
        probe: false,
      });
      for (const name of [
        'unsupported_version_rejected',
        'missing_meta_rejected',
        'header_mismatch_rejected',
        'unknown_method_not_found',
        'no_session_id',
      ]) {
        expect(check(result, name).skipped, name).toBe(true);
      }
      expect(result.pass).toBe(true);
    } finally {
      await closeMCPClient(client);
    }
  }, 30_000);
});
