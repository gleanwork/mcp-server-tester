import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  closeMCPClient,
  createMCPClientForConfig,
} from '../mcp/clientFactory.js';
import { createMCPFixture } from '../mcp/fixtures/mcpFixture.js';
import type { MCPConfig } from '../config/mcpConfig.js';
import { runConformanceChecks } from './conformanceChecks.js';
import type {
  MCPConformanceOptions,
  MCPConformanceResult,
} from './conformanceChecks.js';

/**
 * Integration tests for the 2026-07-28 conformance checks against a scripted
 * server (tests/mocks/rawModernServer.mjs) over HTTP and stdio. Each fault
 * switches on one spec violation; the checks it fails must be exactly the
 * expected set, and a conformant server must pass every check with no
 * warnings.
 */
const serverScript = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../tests/mocks/rawModernServer.mjs'
);

const running: ChildProcess[] = [];

/** Starts the scripted HTTP server on a free port and returns its URL. */
async function startHttpServer(faults: string[]): Promise<string> {
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

async function configFor(
  transport: 'http' | 'stdio',
  faults: string[]
): Promise<MCPConfig> {
  return transport === 'http'
    ? {
        transport: 'http',
        serverUrl: await startHttpServer(faults),
        protocol: '2026-07-28',
      }
    : {
        transport: 'stdio',
        command: process.execPath,
        args: [serverScript, '--stdio'],
        env: { FAULTS: faults.join(',') },
        protocol: '2026-07-28',
      };
}

async function checkServer(
  transport: 'http' | 'stdio',
  faults: string[] = [],
  options: MCPConformanceOptions = {}
): Promise<MCPConformanceResult> {
  const client = await createMCPClientForConfig(
    await configFor(transport, faults)
  );
  try {
    return await runConformanceChecks(createMCPFixture(client), options);
  } finally {
    await closeMCPClient(client);
  }
}

function failing(result: MCPConformanceResult): string[] {
  return result.checks
    .filter((c) => !c.pass && !c.skipped)
    .map((c) => c.name)
    .sort();
}

function check(result: MCPConformanceResult, name: string) {
  const found = result.checks.find((c) => c.name === name);
  if (!found) throw new Error(`check ${name} not reported`);
  return found;
}

afterEach(() => {
  for (const child of running.splice(0)) child.kill();
});

/** Checks that are 'should' (warnings); everything else here is 'must'. */
const SHOULD = new Set([
  'server_info_present',
  'discover_server_info',
  'result_server_info',
  'no_session_id',
  'unknown_tool_protocol_error',
  'tools_list_deterministic',
]);

/**
 * fault → checks it must fail. The SDK itself rejects results without
 * cache hints or resultType, so those faults also fail list_tools_succeeds
 * (and discover_succeeds); a retired error code also fails
 * reserved_error_codes.
 */
const HTTP_FAULTS: Array<[string, string[]]> = [
  ['no-ttl', ['cache_hints_present', 'list_tools_succeeds']],
  [
    'no-result-type',
    ['discover_succeeds', 'list_tools_succeeds', 'result_type_present'],
  ],
  [
    'no-server-info',
    ['discover_server_info', 'result_server_info', 'server_info_present'],
  ],
  ['accept-bad-version', ['unsupported_version_rejected']],
  ['accept-missing-meta', ['missing_meta_rejected']],
  ['ignore-header-mismatch', ['header_mismatch_rejected']],
  ['unknown-method-200', ['unknown_method_not_found']],
  ['mint-session', ['no_session_id']],
  ['echo-session', ['no_session_id']],
  ['not-found-32002', ['reserved_error_codes', 'resource_not_found_error']],
  ['empty-not-found', ['resource_not_found_error']],
  ['unknown-tool-iserror', ['unknown_tool_protocol_error']],
  ['reserved-code', ['reserved_error_codes']],
  ['shuffle-tools', ['tools_list_deterministic']],
  [
    'varying-tools',
    ['tools_list_deterministic', 'tools_list_stable_across_connections'],
  ],
  ['mixed-scope-pages', ['cache_scope_consistent_across_pages']],
];

/** Faults whose rules apply over stdio (HTTP-only rules are skipped). */
const STDIO_FAULTS: Array<[string, string[]]> = [
  ['no-ttl', ['cache_hints_present', 'list_tools_succeeds']],
  ['accept-bad-version', ['unsupported_version_rejected']],
  ['accept-missing-meta', ['missing_meta_rejected']],
  ['not-found-32002', ['reserved_error_codes', 'resource_not_found_error']],
  ['mixed-scope-pages', ['cache_scope_consistent_across_pages']],
];

describe.each([
  ['http', HTTP_FAULTS],
  ['stdio', STDIO_FAULTS],
] as const)('modern-era conformance checks over %s', (transport, faults) => {
  it('a conformant server passes every check with no warnings', async () => {
    const result = await checkServer(transport);
    expect(failing(result)).toEqual([]);
    expect(result.pass).toBe(true);
    expect(result.protocol.era).toBe('modern');
    expect(check(result, 'unsupported_version_rejected').skipped).toBeFalsy();
    expect(check(result, 'missing_meta_rejected').skipped).toBeFalsy();
    expect(
      check(result, 'tools_list_stable_across_connections').skipped
    ).toBeFalsy();
  }, 30_000);

  it('a conformant paginated server passes, including cacheScope across pages', async () => {
    const result = await checkServer(transport, ['paginate']);
    expect(failing(result)).toEqual([]);
    expect(
      check(result, 'cache_scope_consistent_across_pages').skipped
    ).toBeFalsy();
  }, 30_000);

  it.each(faults)(
    'fault %s fails exactly %j',
    async (fault, expected) => {
      const result = await checkServer(transport, [fault]);
      expect(failing(result)).toEqual([...expected].sort());
      for (const name of expected) {
        const failed = check(result, name);
        expect(failed.severity, name).toBe(
          SHOULD.has(name) ? 'should' : 'must'
        );
        expect(failed.specVersion, name).toBe('2026-07-28');
      }
      // Only 'must' failures fail the overall result.
      expect(result.pass).toBe(expected.every((name) => SHOULD.has(name)));
    },
    30_000
  );
});

describe('probe option', () => {
  it('skips probe checks when probes are disabled', async () => {
    const result = await checkServer('http', [], { probe: false });
    for (const name of [
      'tools_list_stable_across_connections',
      'unsupported_version_rejected',
      'missing_meta_rejected',
      'header_mismatch_rejected',
      'unknown_method_not_found',
      'no_session_id',
    ]) {
      expect(check(result, name).skipped, name).toBe(true);
    }
    expect(result.pass).toBe(true);
  }, 30_000);
});
