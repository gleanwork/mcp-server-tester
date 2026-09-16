import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COWORK_HOST } from './coworkHost.js';
import { prepareMacCoworkSession } from './coworkSetup/macSession.js';
import { loadExternalHostConfig } from './externalHost/capabilityRuntime.js';
import { runExternalHostScenario } from './externalHost/runtime.js';
import {
  CLAUDE_COWORK_DESKTOP_MACOS_DRIVER,
  driverToSlug,
} from './externalHost/driverIdentity.js';
import type { ExternalHostRunResult } from './externalHost/types.js';
import type { HostRunContext, HostRunInput } from './evalFrameworkTypes.js';
import { hostTraceToExecution } from './hostTrace.js';
import { runEvalSuite } from './runEvalSuite.js';
import { registerBuiltinHosts } from './builtinHosts.js';
import { getHost } from './frameworkRegistries.js';

vi.mock('./coworkSetup/macSession.js', () => ({
  prepareMacCoworkSession: vi.fn(),
}));
vi.mock('./externalHost/capabilityRuntime.js', () => ({
  loadExternalHostConfig: vi.fn(),
}));
vi.mock('./externalHost/runtime.js', () => ({
  runExternalHostScenario: vi.fn(),
}));
const env = {
  ANTHROPIC_API_KEY: 'synthetic-inference',
  MCP_TOKEN: 'synthetic-mcp',
};
const driver = driverToSlug(CLAUDE_COWORK_DESKTOP_MACOS_DRIVER);
const config = { type: 'cowork', driver };
let input: Omit<HostRunInput, 'scenario'>;
let context: HostRunContext;
const dispose = vi.fn<() => Promise<void>>();
const dirs: string[] = [];
function result(): ExternalHostRunResult {
  return {
    success: true,
    response: 'Found a document',
    toolCalls: [
      {
        name: 'search',
        arguments: { query: 'onboarding' },
        source: 'mcp',
        server: 'search',
      },
    ],
    externalHost: {
      driver: CLAUDE_COWORK_DESKTOP_MACOS_DRIVER,
      driverSlug: driver,
      displayName: 'Cowork',
      hostName: 'Cowork',
      hostType: 'desktop',
      capabilitiesUsed: [],
      traceSource: 'host-local-transcript',
      traceConfidence: 'high',
      artifacts: [],
      session: { runMarker: 'synthetic' },
      correlation: {
        strategy: 'none',
        includedInPrompt: false,
        marker: 'synthetic',
      },
    },
  };
}
beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  input = {
    servers: [
      {
        transport: 'http',
        label: 'search',
        serverUrl: 'https://search.example.test/mcp',
        auth: { accessTokenEnv: 'MCP_TOKEN' },
      },
    ],
    env,
  };
  context = {
    manifest: { name: 'synthetic', datasets: [], servers: input.servers },
    env,
  };
  dispose.mockReset().mockResolvedValue();
  vi.mocked(prepareMacCoworkSession).mockReset().mockResolvedValue({ dispose });
  vi.mocked(loadExternalHostConfig).mockReset();
  vi.mocked(runExternalHostScenario).mockReset().mockResolvedValue(result());
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});
async function prepare() {
  return COWORK_HOST.prepareSession!(input, config, context);
}

describe('automatic Cowork host lifecycle', () => {
  it('registers the existing Cowork driver with mandatory preparation and serial execution', () => {
    registerBuiltinHosts();
    expect(getHost('cowork')).toBe(COWORK_HOST);
    expect(COWORK_HOST.run).toBeUndefined();
    expect(COWORK_HOST.maxConcurrency).toBe(1);
    expect(COWORK_HOST.schema.parse({ type: 'cowork' })).toMatchObject(config);
  });
  it.each(['linux', 'win32', 'freebsd'] as const)(
    'rejects %s before loading a driver or touching the app',
    async (platform) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
      await expect(prepare()).rejects.toThrow(
        `Cowork on ${platform} is not supported yet.`
      );
      expect(loadExternalHostConfig).not.toHaveBeenCalled();
      expect(prepareMacCoworkSession).not.toHaveBeenCalled();
    }
  );
  it.each([
    'anthropic.claude.chat.desktop-app.macos',
    'anthropic.claude.cowork.desktop-app.linux',
    'anthropic.claude.cowork.cli.macos',
  ])('rejects an incompatible driver: %s', async (selected) => {
    await expect(
      COWORK_HOST.prepareSession!(
        input,
        { ...config, driver: selected },
        context
      )
    ).rejects.toThrow('Cowork requires a Claude Cowork macOS desktop driver.');
    expect(prepareMacCoworkSession).not.toHaveBeenCalled();
  });
  it('uses explicit credentials, effective server overrides and inherited setup policy', async () => {
    context.baseManifest = {
      ...context.manifest,
      coworkSetup: { approveWriteTools: true },
    };
    context.manifest = { ...context.manifest, coworkSetup: {} };
    context.arm = { name: 'override', coworkSetup: {}, servers: [] };
    input.servers = [];
    const session = await prepare();
    expect(prepareMacCoworkSession).toHaveBeenCalledWith({
      manifest: {
        name: 'synthetic',
        datasets: [],
        servers: [],
        coworkSetup: { approveWriteTools: true },
      },
      env,
      profileDirectory: undefined,
    });
    expect(runExternalHostScenario).not.toHaveBeenCalled();
    await session.dispose();
  });
  it('allows an arm to cancel write approval', async () => {
    context.baseManifest = {
      ...context.manifest,
      coworkSetup: { approveWriteTools: true },
    };
    context.arm = { name: 'safe', coworkSetup: { approveWriteTools: false } };
    await prepare();
    expect(
      vi.mocked(prepareMacCoworkSession).mock.calls[0]![0].manifest.coworkSetup
    ).toEqual({ approveWriteTools: false });
  });
  it('rejects missing servers instead of retaining unrelated configured connectors', async () => {
    input.servers = [];
    delete context.manifest.servers;
    await expect(prepare()).rejects.toThrow(
      'Cowork requires explicit MCP servers'
    );
    expect(prepareMacCoworkSession).not.toHaveBeenCalled();
  });
  it('does not acquire credentials from ambient environment', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'ambient-inference');
    input.env = { MCP_TOKEN: 'synthetic-mcp' };
    context.env = input.env;
    await expect(prepare()).rejects.toThrow('ANTHROPIC_API_KEY');
    expect(prepareMacCoworkSession).not.toHaveBeenCalled();
  });
  it('rejects unsupported MCP configuration before native preparation', async () => {
    input.servers = [{ transport: 'stdio', command: 'never-execute' }];
    await expect(prepare()).rejects.toThrow(
      'Invalid or unsupported Cowork MCP configuration.'
    );
    expect(prepareMacCoworkSession).not.toHaveBeenCalled();
  });
  it('sanitizes driver load failure and does not touch the app', async () => {
    vi.mocked(loadExternalHostConfig).mockRejectedValue(
      new Error('synthetic-private-error')
    );
    await expect(prepare()).rejects.toThrow(
      'The selected Cowork driver could not be loaded.'
    );
    expect(prepareMacCoworkSession).not.toHaveBeenCalled();
  });
  it('reuses the selected driver and preserves native provenance without claiming inventory verification', async () => {
    const session = await prepare();
    const trace = await session.run(
      { ...input, scenario: 'Find a document' },
      config,
      context
    );
    expect(runExternalHostScenario).toHaveBeenCalledWith(
      'Find a document',
      expect.objectContaining({
        driver,
        options: expect.objectContaining({
          dataDir: expect.stringContaining(
            'Claude-3p/local-agent-mode-sessions'
          ),
        }),
      })
    );
    expect(trace.events[0]).toMatchObject({
      name: 'search',
      source: 'mcp',
      server: 'search',
    });
    expect(trace.externalHost?.traceLimitations).toContain(
      'Managed MCP configuration was prepared; complete native inventory and tool-policy adoption are not independently verified.'
    );
    expect(hostTraceToExecution(trace, 'observed').response).toMatchObject({
      externalHost: trace.externalHost,
    });
    await Promise.all([session.dispose(), session.dispose()]);
    expect(dispose).toHaveBeenCalledTimes(1);
    await expect(
      session.run({ ...input, scenario: 'No' }, config, context)
    ).rejects.toThrow('disposed');
  });
  it('fails rather than inferring native tool provenance from server count', async () => {
    const native = result();
    native.toolCalls = [{ name: 'search', arguments: {} }];
    vi.mocked(runExternalHostScenario).mockResolvedValue(native);
    const session = await prepare();
    const trace = await session.run(
      { ...input, scenario: 'Find' },
      config,
      context
    );
    expect(trace.error).toContain('without source/server provenance');
    expect(trace.events).toEqual([]);
    await session.dispose();
  });
  it('integrates automatic setup, two cases, and disposal through the real suite runner', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cowork-host-suite-'));
    dirs.push(dir);
    await writeFile(
      join(dir, 'cases.json'),
      JSON.stringify({
        name: 'synthetic',
        cases: [
          { id: 'one', mode: 'host', scenario: 'One' },
          { id: 'two', mode: 'host', scenario: 'Two' },
        ],
      })
    );
    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify({
        ...context.manifest,
        datasets: ['./cases.json'],
        host: config,
      })
    );
    const secretsFile = join(dir, 'secrets.json');
    await writeFile(secretsFile, JSON.stringify(env), { mode: 0o600 });
    await runEvalSuite({
      manifestPath: join(dir, 'manifest.json'),
      rootDir: dir,
      secretsFile,
    });
    expect(prepareMacCoworkSession).toHaveBeenCalledTimes(1);
    expect(runExternalHostScenario).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(prepareMacCoworkSession).mock.calls[0]![0].manifest.servers?.[0]
    ).toMatchObject({ auth: { accessToken: 'synthetic-mcp' } });
  });
});
